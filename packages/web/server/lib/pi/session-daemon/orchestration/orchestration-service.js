import { isAbsolute } from 'node:path';

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
export const RESULT_MESSAGE = 'pichamber.orchestration.result';

const RESULT_TEXT_LIMIT = 16 * 1024;
const READ_TEXT_LIMIT = 8 * 1024;
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 3_600_000;

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

/** Worker records of a parent, in spawn order, with their stopped flag. */
export const childRecordsOf = (runtime) => {
  const stopped = new Set(customEntries(runtime, STOPPED_ENTRY).map((entry) => entry.data?.sessionId));
  return customEntries(runtime, CHILD_ENTRY)
    .map((entry) => entry.data)
    .filter((data) => data && typeof data.sessionId === 'string')
    .map((data) => ({ ...data, stopped: stopped.has(data.sessionId) }));
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
    now = () => Date.now(),
  } = deps;

  // Runs this service started that have not settled yet. A run accepted by
  // Pi may not have emitted agent_start yet, so live streaming state alone
  // would let a wait return before the run began.
  const pendingRuns = new Set();
  const waiters = new Set();
  const inflightSpawns = new Map();

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
    const runtime = getLiveRuntime(callerSessionId) ?? await activateSession(callerSessionId);
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

  const startTask = async (sessionId, text, delivery, operationId) => {
    pendingRuns.add(sessionId);
    try {
      return await sendInput({ sessionId, text, delivery, operationId });
    } catch (error) {
      pendingRuns.delete(sessionId);
      notifyWaiters();
      throw error;
    }
  };

  const spawnOnce = async (callerSessionId, runtime, args) => {
    if (typeof args.cwd !== 'string' || !isAbsolute(args.cwd)) {
      throw new OrchestrationError('INVALID_ARGUMENT', 'cwd must be an absolute directory.');
    }
    const settings = await readSettings();
    const workers = activeWorkers(runtime);
    if (workers.length >= settings.workerLimit) {
      throw new OrchestrationError('ORCHESTRATION_LIMIT', `All ${settings.workerLimit} worker slots are in use; stop a finished worker first.`, {
        workerLimit: settings.workerLimit,
        workers: await Promise.all(workers.map(describeWorker)),
      });
    }
    const busyHere = managedRuntimes().find((candidate) => candidate.cwd === args.cwd
      && !isSettled(candidate.session.sessionId));
    if (busyHere) {
      throw new OrchestrationError('ORCHESTRATION_CWD_BUSY', 'A managed worker is busy in this directory; use another worktree.', {
        sessionId: busyHere.session.sessionId,
      });
    }
    const { model, thinking } = await resolveModel(args, settings);
    const title = args.title?.trim() || args.task.trim().split(/\r?\n/)[0].slice(0, 80);
    const lineage = {
      parentSessionId: callerSessionId,
      parentDirectory: runtime.cwd,
      ...(args.role ? { role: args.role } : {}),
    };
    const created = await createWorkerSession({
      cwd: args.cwd,
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
    await startTask(created.sessionId, args.task, 'prompt', args.clientRequestId ? `${args.clientRequestId}.task` : undefined);
    return record;
  };

  const spawn = async (callerSessionId, args, options) => {
    const runtime = await callerRuntime(callerSessionId);
    assertOrchestrator(runtime);
    let record;
    let deduplicated = false;
    if (args.clientRequestId) {
      const existing = childRecordsOf(runtime).find((candidate) => candidate.clientRequestId === args.clientRequestId);
      const key = `${callerSessionId}\u0000${args.clientRequestId}`;
      if (existing) {
        record = existing;
        deduplicated = true;
      } else if (inflightSpawns.has(key)) {
        record = await inflightSpawns.get(key);
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

  const stopTree = async (parentRuntime, sessionId, stopped) => {
    if (stopped.includes(sessionId)) return;
    stopped.push(sessionId);
    pendingRuns.delete(sessionId);
    // Mark first: an abort settles the run, and a stopped worker must not
    // report that settle back to its parent.
    parentRuntime.session.sessionManager.appendCustomEntry(STOPPED_ENTRY, { sessionId, stoppedAt: now() });
    const child = getLiveRuntime(sessionId);
    if (child) {
      for (const grandchild of childRecordsOf(child).filter((record) => !record.stopped)) {
        await stopTree(child, grandchild.sessionId, stopped);
      }
    }
    await abortSession(sessionId).catch(() => {});
  };

  const stop = async (callerSessionId, args) => {
    const runtime = await callerRuntime(callerSessionId);
    assertOrchestrator(runtime);
    const record = childRecordsOf(runtime).find((candidate) => candidate.sessionId === args.sessionId);
    if (!record) {
      throw new OrchestrationError('ORCHESTRATION_FORBIDDEN', 'Only your own workers can be stopped.');
    }
    if (record.stopped) return { sessionId: args.sessionId, stopped: [], alreadyStopped: true };
    const stopped = [];
    await stopTree(runtime, args.sessionId, stopped);
    notifyWaiters();
    return { sessionId: args.sessionId, stopped };
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
   * Execute one tool as `callerSessionId`. Arguments are validated by the
   * adapter against the shared JSON Schema contracts.
   */
  const call = async (callerSessionId, toolName, args = {}, options = {}) => {
    if (!toolByName.has(toolName)) {
      throw new OrchestrationError('UNKNOWN_TOOL', `Unknown orchestration tool: ${toolName}`);
    }
    if (typeof callerSessionId !== 'string' || callerSessionId.length === 0) {
      throw new OrchestrationError('SESSION_NOT_FOUND', 'The calling session is unknown.');
    }
    return handlers[toolName](callerSessionId, args ?? {}, options);
  };

  /**
   * Called by the daemon for every agent_settled. Resolves waits and delivers
   * a worker's result to its parent as a custom message that starts a parent
   * turn, or queues as follow-up while the parent is busy.
   */
  const onSessionSettled = async (sessionId, runtime) => {
    pendingRuns.delete(sessionId);
    notifyWaiters();
    const lineage = lineageOf(runtime);
    if (!lineage?.parentSessionId) return;
    const parent = getLiveRuntime(lineage.parentSessionId)
      ?? await activateSession(lineage.parentSessionId, lineage.parentDirectory);
    const record = childRecordsOf(parent).find((candidate) => candidate.sessionId === sessionId);
    if (!record || record.stopped) return;
    const assistant = lastAssistant(runtime);
    const outcome = outcomeOf(assistant);
    const reply = truncate(textOf(assistant?.content), RESULT_TEXT_LIMIT);
    const title = runtime.session.sessionManager?.getSessionName?.() || record.title;
    const header = `Worker "${title}" (${sessionId}) ${outcome === 'completed' ? 'finished' : outcome === 'interrupted' ? 'was interrupted' : 'failed'}.`;
    await parent.session.sendCustomMessage({
      customType: RESULT_MESSAGE,
      content: [header, assistant?.errorMessage ? `Error: ${assistant.errorMessage}` : '', reply].filter(Boolean).join('\n\n'),
      display: true,
      details: { sessionId, title, cwd: runtime.cwd, outcome, ...(record.role ? { role: record.role } : {}) },
    }, { triggerTurn: true, deliverAs: 'followUp' });
  };

  return {
    call,
    onSessionSettled,
    isWorker: (sessionManager) => Boolean(lineageOf({ session: { sessionManager } })),
    toolNames: ORCHESTRATION_TOOL_NAMES,
  };
}
