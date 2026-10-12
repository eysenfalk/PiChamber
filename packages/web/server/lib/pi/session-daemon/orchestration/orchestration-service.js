import { isAbsolute, resolve } from 'node:path';

import { schemaViolation } from './contract-validator.js';
import { ORCHESTRATION_TOOL_NAMES, ORCHESTRATION_TOOLS } from './tool-contracts.js';

// Daemon-owned orchestration: tool semantics, permissions, limits, lineage,
// idempotency and completion delivery. Adapters (the in-process Pi extension
// and the MCP endpoint) only resolve the calling session and forward here.
//
// Lineage lives in Pi's own session files, no separate store:
// - the child's JSONL header names its parent (`parentSession`), and the child
//   carries a `pichamber.orchestration.lineage` entry with the parent id;
// - the parent carries one `pichamber.orchestration.child` entry per worker
//   and a `pichamber.orchestration.stopped` entry once it stopped it.

export const LINEAGE_ENTRY = 'pichamber.orchestration.lineage';
export const CHILD_ENTRY = 'pichamber.orchestration.child';
const STOPPED_ENTRY = 'pichamber.orchestration.stopped';
const TASK_REJECTED = 'task_rejected';
export const RESULT_MESSAGE = 'pichamber.orchestration.result';

const RESULT_TEXT_LIMIT = 16 * 1024;
const READ_TEXT_LIMIT = 8 * 1024;
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 3_600_000;
// Result delivery retries a parent that cannot be reached: 1s, 2s, 4s, then
// the failure is reported instead of dropped silently.
const DELIVERY_ATTEMPTS = 4;
const DELIVERY_RETRY_MS = 1_000;
// Codes with which the daemon reports a session that no longer exists.
const GONE_CODES = new Set(['INVALID_SESSION', 'SESSION_NOT_FOUND']);
// A lookup that failed on storage errors is marked `incomplete`: the
// session may still exist, so it is not treated as gone.
const isGone = (error) => GONE_CODES.has(error?.code) && error?.incomplete !== true;
// The session a call acts as was deleted; adapters revoke its credentials.
export const CALLER_GONE = 'ORCHESTRATION_CALLER_GONE';

export class OrchestrationError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'OrchestrationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const customEntries = (runtime, customType) => {
  const entries = runtime?.session?.sessionManager?.getEntries?.() ?? [];
  return entries.filter((entry) => entry?.type === 'custom' && entry.customType === customType);
};

const lineageOf = (runtime) => customEntries(runtime, LINEAGE_ENTRY).at(-1)?.data;

/**
 * Worker records of a parent, in spawn order, with their stopped flag. A
 * worker whose first task Pi rejected is stopped and `rejected`: it holds no
 * slot and a spawn retry with the same key starts a new worker.
 */
export const childRecordsOf = (runtime) => {
  const stopped = new Map(customEntries(runtime, STOPPED_ENTRY).map((entry) => [entry.data?.sessionId, entry.data]));
  return customEntries(runtime, CHILD_ENTRY)
    .map((entry) => entry.data)
    .filter((data) => data && typeof data.sessionId === 'string')
    .map((data) => ({
      ...data,
      stopped: stopped.has(data.sessionId),
      ...(stopped.get(data.sessionId)?.reason === TASK_REJECTED ? { rejected: true } : {}),
    }));
};

const truncate = (text, limit) => {
  if (typeof text !== 'string') return '';
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text;
};

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n');
};

const lastAssistant = (runtime) => {
  const messages = runtime?.session?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') return messages[index];
  }
  return undefined;
};

const outcomeOf = (message) => {
  if (!message) return 'completed';
  if (message.stopReason === 'aborted') return 'interrupted';
  if (typeof message.errorMessage === 'string' || message.stopReason === 'error') return 'error';
  return 'completed';
};

const lastTimestamp = (runtime) => {
  const timestamp = runtime?.session?.messages?.at?.(-1)?.timestamp;
  return Number.isFinite(timestamp) ? timestamp : undefined;
};

const toolByName = new Map(ORCHESTRATION_TOOLS.map((tool) => [tool.name, tool]));

/**
 * @param {object} deps daemon operations; see session-daemon.js for the wiring.
 */
export function createOrchestrationService(deps) {
  const {
    activateSession,
    getLiveRuntime,
    listLiveRuntimes,
    getSessionState,
    createWorkerSession,
    sendInput,
    abortSession,
    readSettings,
    listModels,
    hostStatus,
    resolveBranch = async () => undefined,
    getSessionActivity = () => ({}),
    canonicalDirectory = async (directory) => resolve(directory),
    onDeliveryFailed = () => {},
    delay = (ms) => new Promise((done) => { setTimeout(done, ms); }),
    now = () => Date.now(),
  } = deps;

  // Runs this service started that have not settled yet. A run accepted by
  // Pi may not have emitted agent_start yet, so live streaming state alone
  // would let a wait return before the run began.
  // Each send holds its own token until its run settles, so a retry that
  // only returns a stored receipt never releases a newer send's pending run.
  const pendingRuns = new Map();
  const waiters = new Set();
  const inflightSpawns = new Map();
  // Admission reservations of spawns between their checks and their first
  // accepted task: worker slots per parent and canonical directories.
  const reservedSlots = new Map();
  const reservedDirectories = new Set();
  // Workers whose stop is aborting them; their settle is not reported back.
  const stopping = new Set();

  const stateOf = (sessionId) => {
    const state = getSessionState(sessionId);
    if (pendingRuns.has(sessionId) && state !== 'busy' && state !== 'retry') return 'starting';
    return state;
  };
  const isSettled = (sessionId) => {
    const state = stateOf(sessionId);
    return state === 'idle' || state === 'dormant';
  };

  const notifyWaiters = () => {
    for (const waiter of waiters) waiter.check();
  };

  const callerRuntime = async (callerSessionId) => {
    let runtime = getLiveRuntime(callerSessionId);
    if (!runtime) {
      try {
        runtime = await activateSession(callerSessionId);
      } catch (error) {
        if (isGone(error)) throw new OrchestrationError(CALLER_GONE, 'The calling session no longer exists.');
        if (GONE_CODES.has(error?.code)) {
          throw new OrchestrationError('SESSION_LOOKUP_FAILED', 'The calling session could not be looked up; retry later.');
        }
        throw error;
      }
    }
    if (!runtime) throw new OrchestrationError('SESSION_NOT_FOUND', 'The calling session is not available.');
    return runtime;
  };

  const assertOrchestrator = (runtime) => {
    if (lineageOf(runtime)) {
      throw new OrchestrationError('ORCHESTRATION_FORBIDDEN', 'Workers cannot start or stop sessions.');
    }
  };

  // Signals an orchestrator needs to spot a stuck worker: how long the
  // current run has lasted, how long since its transcript last moved, an
  // automatic retry after a provider error, and a blocking dialog. Only
  // present while the worker runs; a settled run reports outcome and error.
  const activityOf = (sessionId, runtime, state) => {
    if (state !== 'busy' && state !== 'retry' && state !== 'starting') return undefined;
    const { runStartedAt, retry, waitingForInput } = getSessionActivity(sessionId) ?? {};
    const at = now();
    const last = lastTimestamp(runtime);
    const activity = {
      ...(Number.isFinite(runStartedAt) ? { runningForMs: Math.max(0, at - runStartedAt) } : {}),
      ...(last !== undefined ? { quietForMs: Math.max(0, at - Math.max(last, runStartedAt ?? 0)) } : {}),
      ...(retry ? { retry: { attempt: retry.attempt, error: retry.message } } : {}),
      ...(waitingForInput ? { waitingForInput: true } : {}),
    };
    return Object.keys(activity).length ? activity : undefined;
  };

  const runStatus = (sessionId, runtime, state) => {
    const assistant = lastAssistant(runtime);
    const activity = activityOf(sessionId, runtime, state);
    return {
      ...(assistant ? { outcome: outcomeOf(assistant) } : {}),
      ...(typeof assistant?.errorMessage === 'string' ? { error: assistant.errorMessage } : {}),
      ...(activity ? { activity } : {}),
    };
  };

  const describeWorker = async (record) => {
    const live = getLiveRuntime(record.sessionId);
    const state = record.stopped ? 'stopped' : stateOf(record.sessionId);
    return {
      sessionId: record.sessionId,
      title: record.title,
      cwd: record.cwd,
      role: record.role,
      branch: await resolveBranch(record.cwd).catch(() => undefined),
      state,
      ...(live ? runStatus(record.sessionId, live, state) : { resident: false }),
    };
  };

  const activeWorkers = (runtime) => childRecordsOf(runtime).filter((record) => !record.stopped);

  const managedRuntimes = () => listLiveRuntimes().filter((runtime) => lineageOf(runtime));

  const resolveModel = async (args, settings) => {
    const role = args.role ? settings.roles[args.role] : undefined;
    if (args.role && !role) {
      throw new OrchestrationError('INVALID_ARGUMENT', `Unknown role: ${args.role}`);
    }
    const requested = args.model ?? (role ? { providerId: role.providerId, modelId: role.modelId } : undefined);
    const thinking = args.thinking ?? role?.thinking;
    if (!requested) return { thinking };
    const models = await listModels();
    const matches = models.filter((model) => model.modelId === requested.modelId
      && (!requested.providerId || model.providerId === requested.providerId));
    const chosen = matches.find((model) => model.available !== false) ?? matches[0];
    if (!chosen) {
      throw new OrchestrationError('ORCHESTRATION_MODEL_UNAVAILABLE', `Model ${requested.providerId ? `${requested.providerId}/` : ''}${requested.modelId} is not in the model catalog.`);
    }
    return { model: { providerId: chosen.providerId, modelId: chosen.modelId }, thinking };
  };

  const capabilities = async (callerSessionId) => {
    const runtime = await callerRuntime(callerSessionId);
    const settings = await readSettings();
    const workers = await Promise.all(activeWorkers(runtime).map(describeWorker));
    return {
      workerLimit: settings.workerLimit,
      freeSlots: Math.max(0, settings.workerLimit - workers.length),
      roles: settings.roles,
      models: await listModels(),
      workers,
      host: hostStatus(),
      canSpawn: !lineageOf(runtime),
    };
  };

  // A run counts as pending from the send until its settle. A deduplicated
  // receipt or a failed send starts no run, so it drops only its own token.
  const startTask = async (sessionId, text, delivery, operationId) => {
    const token = {};
    const tokens = pendingRuns.get(sessionId) ?? new Set();
    tokens.add(token);
    pendingRuns.set(sessionId, tokens);
    const dropToken = () => {
      const current = pendingRuns.get(sessionId);
      if (!current?.delete(token)) return;
      if (current.size === 0) pendingRuns.delete(sessionId);
      notifyWaiters();
    };
    try {
      const receipt = await sendInput({ sessionId, text, delivery, operationId });
      if (receipt?.deduplicated) dropToken();
      return receipt;
    } catch (error) {
      dropToken();
      throw error;
    }
  };

  const releaseAdmission = (callerSessionId, cwd) => {
    const slots = (reservedSlots.get(callerSessionId) ?? 1) - 1;
    if (slots > 0) reservedSlots.set(callerSessionId, slots);
    else reservedSlots.delete(callerSessionId);
    reservedDirectories.delete(cwd);
  };

  const spawnOnce = async (callerSessionId, runtime, args) => {
    if (typeof args.cwd !== 'string' || !isAbsolute(args.cwd)) {
      throw new OrchestrationError('INVALID_ARGUMENT', 'cwd must be an absolute directory.');
    }
    const settings = await readSettings();
    const cwd = await canonicalDirectory(args.cwd);
    // Admission is synchronous from here to the reservation: no await may sit
    // between the checks and the reservation, or two concurrent spawns pass
    // the same free slot or directory.
    const workers = activeWorkers(runtime);
    if (workers.length + (reservedSlots.get(callerSessionId) ?? 0) >= settings.workerLimit) {
      throw new OrchestrationError('ORCHESTRATION_LIMIT', `All ${settings.workerLimit} worker slots are in use; stop a finished worker first.`, {
        workerLimit: settings.workerLimit,
        workers: await Promise.all(workers.map(describeWorker)),
      });
    }
    const busyId = reservedDirectories.has(cwd)
      ? undefined
      : managedRuntimes().find((candidate) => resolve(candidate.cwd) === cwd
        && !isSettled(candidate.session.sessionId))?.session.sessionId;
    if (reservedDirectories.has(cwd) || busyId) {
      throw new OrchestrationError('ORCHESTRATION_CWD_BUSY', 'A managed worker is busy in this directory; use another worktree.', {
        ...(busyId ? { sessionId: busyId } : {}),
      });
    }
    reservedSlots.set(callerSessionId, (reservedSlots.get(callerSessionId) ?? 0) + 1);
    reservedDirectories.add(cwd);
    try {
      const { model, thinking } = await resolveModel(args, settings);
      const title = args.title?.trim() || args.task.trim().split(/\r?\n/)[0].slice(0, 80);
      const lineage = {
        parentSessionId: callerSessionId,
        parentDirectory: runtime.cwd,
        ...(args.role ? { role: args.role } : {}),
      };
      const created = await createWorkerSession({
        cwd,
        title,
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
        parentSessionPath: runtime.session.sessionFile,
        lineage,
      });
      const record = {
        sessionId: created.sessionId,
        cwd: created.cwd,
        title,
        ...(args.role ? { role: args.role } : {}),
        ...(model ? { model } : {}),
        ...(args.clientRequestId ? { clientRequestId: args.clientRequestId } : {}),
        createdAt: now(),
      };
      runtime.session.sessionManager.appendCustomEntry(CHILD_ENTRY, record);
      try {
        await startTask(created.sessionId, args.task, 'prompt', args.clientRequestId ? `${args.clientRequestId}.task` : undefined);
      } catch (error) {
        // Pi persisted nothing for the rejected first prompt, so the idle
        // ephemeral cleanup removes the worker session. The record frees its
        // slot and a retry with the same key starts a new worker.
        runtime.session.sessionManager.appendCustomEntry(STOPPED_ENTRY, { sessionId: created.sessionId, stoppedAt: now(), reason: TASK_REJECTED });
        throw error;
      }
      return record;
    } finally {
      releaseAdmission(callerSessionId, cwd);
    }
  };

  const spawn = async (callerSessionId, args, options) => {
    const runtime = await callerRuntime(callerSessionId);
    assertOrchestrator(runtime);
    let record;
    let deduplicated = false;
    if (args.clientRequestId) {
      const key = `${callerSessionId}\u0000${args.clientRequestId}`;
      // A running spawn wrote its record before its first task was accepted,
      // so a retry shares that operation's outcome before it trusts a record.
      const existing = inflightSpawns.has(key)
        ? undefined
        : childRecordsOf(runtime).find((candidate) => candidate.clientRequestId === args.clientRequestId && !candidate.rejected);
      if (inflightSpawns.has(key)) {
        record = await inflightSpawns.get(key);
        deduplicated = true;
      } else if (existing) {
        record = existing;
        deduplicated = true;
      } else {
        const operation = spawnOnce(callerSessionId, runtime, args);
        inflightSpawns.set(key, operation);
        try {
          record = await operation;
        } finally {
          inflightSpawns.delete(key);
        }
      }
    } else {
      record = await spawnOnce(callerSessionId, runtime, args);
    }
    const result = {
      sessionId: record.sessionId,
      cwd: record.cwd,
      title: record.title,
      ...(record.role ? { role: record.role } : {}),
      ...(record.model ? { model: record.model } : {}),
      ...(deduplicated ? { deduplicated: true } : {}),
    };
    if (args.mode === 'wait') {
      const waited = await wait(callerSessionId, { sessionIds: [record.sessionId], timeoutMs: args.timeoutMs }, options);
      return { ...result, ...waited.sessions[0], timedOut: waited.timedOut };
    }
    return { ...result, state: stateOf(record.sessionId) };
  };

  const list = async (callerSessionId, args = {}) => {
    const runtime = await callerRuntime(callerSessionId);
    if (args.scope === 'all') {
      return {
        sessions: listLiveRuntimes().map((candidate) => {
          const sessionId = candidate.session.sessionId;
          const state = stateOf(sessionId);
          return {
            sessionId,
            cwd: candidate.cwd,
            title: candidate.session.sessionManager?.getSessionName?.(),
            state,
            ...runStatus(sessionId, candidate, state),
            ...(lineageOf(candidate) ? { parentSessionId: lineageOf(candidate).parentSessionId } : {}),
          };
        }),
      };
    }
    return { sessions: await Promise.all(childRecordsOf(runtime).map(describeWorker)) };
  };

  const snapshot = (sessionId, runtime) => {
    const assistant = lastAssistant(runtime);
    const state = stateOf(sessionId);
    return {
      sessionId,
      state,
      ...runStatus(sessionId, runtime, state),
      ...(assistant ? { lastReply: truncate(textOf(assistant.content), READ_TEXT_LIMIT) } : {}),
    };
  };

  const read = async (_callerSessionId, args) => {
    const runtime = getLiveRuntime(args.sessionId) ?? await activateSession(args.sessionId);
    const limit = args.limit ?? 10;
    const messages = (runtime.session.messages ?? [])
      .filter((message) => message?.role === 'user' || message?.role === 'assistant' || message?.role === 'custom')
      .slice(-limit)
      .map((message) => ({
        role: message.role,
        ...(message.customType ? { customType: message.customType } : {}),
        text: truncate(textOf(message.content), READ_TEXT_LIMIT),
      }))
      .filter((message) => message.text.length > 0);
    const lineage = lineageOf(runtime);
    return {
      ...snapshot(args.sessionId, runtime),
      cwd: runtime.cwd,
      title: runtime.session.sessionManager?.getSessionName?.(),
      ...(lineage ? { parentSessionId: lineage.parentSessionId } : {}),
      messages,
    };
  };

  const send = async (_callerSessionId, args) => {
    const runtime = getLiveRuntime(args.sessionId) ?? await activateSession(args.sessionId);
    const receipt = await startTask(runtime.session.sessionId, args.text, args.delivery ?? 'prompt', args.clientRequestId);
    return {
      sessionId: args.sessionId,
      accepted: true,
      ...(receipt?.deduplicated ? { deduplicated: true } : {}),
      state: stateOf(args.sessionId),
    };
  };

  const wait = async (_callerSessionId, args, options = {}) => {
    const sessionIds = [...new Set(args.sessionIds)];
    for (const sessionId of sessionIds) {
      if (!getLiveRuntime(sessionId)) await activateSession(sessionId);
    }
    const cap = Math.min(options.maxWaitMs ?? MAX_WAIT_MS, MAX_WAIT_MS);
    const timeoutMs = Math.min(args.timeoutMs ?? DEFAULT_WAIT_MS, cap);
    const until = args.until ?? 'all';
    const done = () => (until === 'any' ? sessionIds.some(isSettled) : sessionIds.every(isSettled));
    let timedOut = false;
    if (!done()) {
      timedOut = await new Promise((resolve) => {
        const waiter = {
          check: () => {
            if (!done()) return;
            finish(false);
          },
        };
        const finish = (value) => {
          clearTimeout(timer);
          waiters.delete(waiter);
          options.signal?.removeEventListener?.('abort', onAbort);
          resolve(value);
        };
        const onAbort = () => finish(true);
        const timer = setTimeout(() => finish(true), timeoutMs);
        options.signal?.addEventListener?.('abort', onAbort, { once: true });
        waiters.add(waiter);
      });
    }
    return {
      timedOut,
      sessions: sessionIds.map((sessionId) => snapshot(sessionId, getLiveRuntime(sessionId))),
    };
  };

  const interrupt = async (_callerSessionId, args) => {
    await abortSession(args.sessionId);
    return { sessionId: args.sessionId, interrupted: true };
  };

  // Stops the worker and its own workers, deepest first. A worker counts as
  // stopped only after its abort succeeded or it no longer exists; until then
  // `stopping` holds back the result the abort settles. A failed abort keeps
  // the worker's slot, and its ancestors stay running so a retry can finish.
  const stopTree = async (parentRuntime, sessionId, result) => {
    if (result.stopped.includes(sessionId)) return true;
    stopping.add(sessionId);
    try {
      const child = getLiveRuntime(sessionId);
      let descendantsStopped = true;
      if (child) {
        for (const grandchild of childRecordsOf(child).filter((record) => !record.stopped)) {
          if (!await stopTree(child, grandchild.sessionId, result)) descendantsStopped = false;
        }
      }
      if (!descendantsStopped) {
        result.failed.push({ sessionId, code: 'ORCHESTRATION_DESCENDANT_STOP_FAILED' });
        return false;
      }
      try {
        await abortSession(sessionId);
      } catch (error) {
        if (!isGone(error)) {
          result.failed.push({ sessionId, code: typeof error?.code === 'string' ? error.code : 'ABORT_FAILED' });
          return false;
        }
      }
      pendingRuns.delete(sessionId);
      parentRuntime.session.sessionManager.appendCustomEntry(STOPPED_ENTRY, { sessionId, stoppedAt: now() });
      result.stopped.push(sessionId);
      return true;
    } finally {
      stopping.delete(sessionId);
    }
  };

  const stop = async (callerSessionId, args) => {
    const runtime = await callerRuntime(callerSessionId);
    assertOrchestrator(runtime);
    const record = childRecordsOf(runtime).find((candidate) => candidate.sessionId === args.sessionId);
    if (!record) {
      throw new OrchestrationError('ORCHESTRATION_FORBIDDEN', 'Only your own workers can be stopped.');
    }
    if (record.stopped) return { sessionId: args.sessionId, stopped: [], alreadyStopped: true };
    const result = { stopped: [], failed: [] };
    await stopTree(runtime, args.sessionId, result);
    notifyWaiters();
    if (result.failed.length > 0) {
      throw new OrchestrationError('ORCHESTRATION_STOP_FAILED', 'Some workers could not be aborted and keep running; retry session_stop.', {
        sessionId: args.sessionId,
        ...result,
      });
    }
    return { sessionId: args.sessionId, stopped: result.stopped };
  };

  const handlers = {
    orchestration_capabilities: (caller) => capabilities(caller),
    session_spawn: spawn,
    session_list: list,
    session_read: read,
    session_send: send,
    session_wait: wait,
    session_interrupt: interrupt,
    session_stop: stop,
  };

  /**
   * Execute one tool as `callerSessionId`. The arguments are validated here
   * against the shared contracts, so both adapters get the same bounds, and
   * the caller must still exist for every tool: a credential of a deleted
   * session cannot act on other sessions.
   */
  const call = async (callerSessionId, toolName, args = {}, options = {}) => {
    const tool = toolByName.get(toolName);
    if (!tool) {
      throw new OrchestrationError('UNKNOWN_TOOL', `Unknown orchestration tool: ${toolName}`);
    }
    if (typeof callerSessionId !== 'string' || callerSessionId.length === 0) {
      throw new OrchestrationError('SESSION_NOT_FOUND', 'The calling session is unknown.');
    }
    const input = args ?? {};
    const violation = schemaViolation(tool.parameters, input);
    if (violation) throw new OrchestrationError('INVALID_ARGUMENT', violation);
    await callerRuntime(callerSessionId);
    return handlers[toolName](callerSessionId, input, options);
  };

  /** Confirms that a session exists before a credential is issued for it. */
  const verifyCaller = async (callerSessionId) => {
    await callerRuntime(callerSessionId);
    return { sessionId: callerSessionId };
  };

  /**
   * Called by the daemon when a send finished without an agent turn (a
   * handled extension command), so no agent_settled follows.
   */
  const onInputCompleted = (sessionId) => {
    if (!pendingRuns.delete(sessionId)) return;
    notifyWaiters();
  };

  const deliverResult = async (sessionId, result, lineage) => {
    const parent = getLiveRuntime(lineage.parentSessionId)
      ?? await activateSession(lineage.parentSessionId, lineage.parentDirectory);
    const record = childRecordsOf(parent).find((candidate) => candidate.sessionId === sessionId);
    if (!record || record.stopped || stopping.has(sessionId)) return;
    const { assistant, cwd } = result;
    const outcome = outcomeOf(assistant);
    const reply = truncate(textOf(assistant?.content), RESULT_TEXT_LIMIT);
    const title = result.title || record.title;
    const header = `Worker "${title}" (${sessionId}) ${outcome === 'completed' ? 'finished' : outcome === 'interrupted' ? 'was interrupted' : 'failed'}.`;
    await parent.session.sendCustomMessage({
      customType: RESULT_MESSAGE,
      content: [header, assistant?.errorMessage ? `Error: ${assistant.errorMessage}` : '', reply].filter(Boolean).join('\n\n'),
      display: true,
      details: { sessionId, title, cwd, outcome, ...(record.role ? { role: record.role } : {}) },
    }, { triggerTurn: true, deliverAs: 'followUp' });
  };

  /**
   * Called by the daemon for every agent_settled. Resolves waits and delivers
   * a worker's result to its parent as a custom message that starts a parent
   * turn, or queues as follow-up while the parent is busy. A parent that
   * cannot be reached is retried with backoff; a deleted parent drops the
   * result, and a final failure is reported through `onDeliveryFailed`.
   */
  const onSessionSettled = async (sessionId, runtime) => {
    pendingRuns.delete(sessionId);
    notifyWaiters();
    if (stopping.has(sessionId)) return;
    const lineage = lineageOf(runtime);
    if (!lineage?.parentSessionId) return;
    // The settled turn's result, taken before any await: a later turn of the
    // worker must not replace it while a delivery retry waits.
    const result = {
      assistant: lastAssistant(runtime),
      title: runtime.session.sessionManager?.getSessionName?.(),
      cwd: runtime.cwd,
    };
    for (let attempt = 1; ; attempt += 1) {
      try {
        await deliverResult(sessionId, result, lineage);
        return;
      } catch (error) {
        if (isGone(error)) return;
        if (attempt >= DELIVERY_ATTEMPTS) {
          onDeliveryFailed({ sessionId, parentSessionId: lineage.parentSessionId, parentDirectory: lineage.parentDirectory, error });
          return;
        }
        await delay(DELIVERY_RETRY_MS * 2 ** (attempt - 1));
      }
    }
  };

  return {
    call,
    onSessionSettled,
    onInputCompleted,
    verifyCaller,
    isWorker: (sessionManager) => Boolean(lineageOf({ session: { sessionManager } })),
    toolNames: ORCHESTRATION_TOOL_NAMES,
  };
}
