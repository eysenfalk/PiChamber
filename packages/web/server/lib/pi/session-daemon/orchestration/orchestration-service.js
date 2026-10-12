import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { OrchestrationError } from './errors.js';
import { workerPreamble } from './instructions.js';
import { authorize, needsOwnership } from './policy.js';
import { ORCHESTRATION_TOOL_NAMES, ORCHESTRATION_TOOLS } from './tool-contracts.js';
import {
  applyDurability,
  applySettle,
  beginStep,
  ensureOwner,
  failOperation,
  finishStep,
  importLineage,
  keepInput,
  ownedOperation,
  recordSession,
  releaseInput,
  requestKey,
  reserveForInput,
  reserveSpawn,
  slotsInUse,
  takeOver,
} from './worker-registry.js';

// Daemon-owned orchestration: tool semantics, permissions, limits, ownership,
// idempotency and completion delivery. Adapters (the in-process Pi extension
// and the MCP endpoint) only resolve the calling session and forward here.
//
// Ownership and bookkeeping live in the durable registry
// (`registry-store.js`, rules in `worker-registry.js`). A worker still
// carries a `pichamber.orchestration.lineage` entry naming its first parent
// and start operation; it marks the session as a worker. #107 kept workers as
// `pichamber.orchestration.child` entries in the orchestrator's JSONL; those
// are imported into the registry once per orchestrator and not read again.

export const LINEAGE_ENTRY = 'pichamber.orchestration.lineage';
export const CHILD_ENTRY = 'pichamber.orchestration.child';
const STOPPED_ENTRY = 'pichamber.orchestration.stopped';
export const RESULT_MESSAGE = 'pichamber.orchestration.result';

const RESULT_TEXT_LIMIT = 16 * 1024;
const READ_TEXT_LIMIT = 8 * 1024;
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 3_600_000;

const customEntries = (runtime, customType) => {
  const entries = runtime?.session?.sessionManager?.getEntries?.() ?? [];
  return entries.filter((entry) => entry?.type === 'custom' && entry.customType === customType);
};

const lineageOf = (runtime) => customEntries(runtime, LINEAGE_ENTRY).at(-1)?.data;

/** Worker records of a parent, in spawn order, with their stopped flag. */
const childRecordsOf = (runtime) => {
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

// Signal 0 probes a pid without touching it; EPERM means it exists.
const defaultIsProcessAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const toolByName = new Map(ORCHESTRATION_TOOLS.map((tool) => [tool.name, tool]));

/**
 * @param {object} deps daemon operations; see session-daemon.js for the wiring.
 */
export function createOrchestrationService(deps) {
  const {
    registry,
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
    // 'present' | 'absent' | 'unknown' for the worker's JSONL.
    sessionFileState = async () => 'unknown',
    // A live session created for this start operation, if any.
    findSessionByOperation = async () => undefined,
    now = () => Date.now(),
    processId = process.pid,
    isProcessAlive = defaultIsProcessAlive,
  } = deps;

  // Several daemons can share one data root. Every transitional record
  // names the process that drives it, so the restart check of one process
  // never finishes what a live other process is still doing.
  const self = { pid: processId, instance: randomUUID() };
  const belongsToLiveProcess = (owner) => Boolean(owner)
    && (owner.instance === self.instance || isProcessAlive(owner.pid));

  // Runs this service started that have not settled yet. A run accepted by
  // Pi may not have emitted agent_start yet, so live streaming state alone
  // would let a wait return before the run began.
  const pendingRuns = new Set();
  const waiters = new Set();
  // In-process guards only; the registry is the durable record.
  const inflightSpawns = new Map();
  const runningOperations = new Map();
  const inputsInFlight = new Map();
  const imported = new Set();

  const stateOf = (sessionId) => {
    const state = getSessionState(sessionId);
    if (pendingRuns.has(sessionId) && state !== 'busy' && state !== 'retry') return 'starting';
    return state;
  };
  const isSettled = (sessionId) => {
    const state = stateOf(sessionId);
    return state === 'idle' || state === 'dormant';
  };
  const hasLiveRun = (sessionId) => {
    const state = getSessionState(sessionId);
    return state === 'busy' || state === 'retry';
  };

  const notifyWaiters = () => {
    for (const waiter of waiters) waiter.check();
  };

  const callerRuntime = async (callerSessionId) => {
    const runtime = getLiveRuntime(callerSessionId) ?? await activateSession(callerSessionId);
    if (!runtime) throw new OrchestrationError('SESSION_NOT_FOUND', 'The calling session is not available.');
    return runtime;
  };

  const ensureImported = async (orchestratorSessionId, runtime) => {
    if (imported.has(orchestratorSessionId)) return;
    const children = childRecordsOf(runtime);
    await registry.update((document) => {
      ensureOwner(document, orchestratorSessionId, runtime.cwd);
      importLineage(document, orchestratorSessionId, children, now());
    });
    imported.add(orchestratorSessionId);
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

  const describeWorker = async (sessionId, worker) => {
    const live = getLiveRuntime(sessionId);
    const state = worker.state === 'stopped' ? 'stopped' : stateOf(sessionId);
    return {
      sessionId,
      title: worker.title,
      cwd: worker.cwd,
      role: worker.role,
      branch: await resolveBranch(worker.cwd).catch(() => undefined),
      state,
      lifecycle: worker.state,
      ...(live ? runStatus(sessionId, live, state) : { resident: false }),
    };
  };

  const workersOf = (document, orchestratorSessionId, { includeStopped = true } = {}) => Object.entries(document.workers)
    .filter(([, worker]) => worker.orchestratorSessionId === orchestratorSessionId
      && worker.state !== 'removed'
      && (includeStopped || worker.state !== 'stopped'));

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

  const capabilities = async (callerSessionId, _args, _options, context) => {
    const settings = await readSettings();
    const document = await registry.read();
    const workers = await Promise.all(workersOf(document, callerSessionId, { includeStopped: false })
      .map(([sessionId, worker]) => describeWorker(sessionId, worker)));
    const operations = Object.entries(document.operations)
      .filter(([, operation]) => operation.orchestratorSessionId === callerSessionId && operation.state === 'reserved')
      .map(([opId, operation]) => ({ opId, step: operation.step, clientRequestId: operation.clientRequestId, title: operation.intent?.title }));
    return {
      workerLimit: settings.workerLimit,
      freeSlots: Math.max(0, settings.workerLimit - slotsInUse(document)),
      roles: settings.roles,
      models: await listModels(),
      workers,
      ...(operations.length ? { operations } : {}),
      host: hostStatus(),
      canSpawn: context.callerKind === 'orchestrator',
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

  // Runs the unfinished steps of a start operation. Every registry write
  // checks that the operation still belongs to `caller`; after a takeover the
  // old call stops with ORCHESTRATION_OWNER_CHANGED.
  const runOperation = async (opId, caller, runtime) => {
    runningOperations.set(opId, caller);
    try {
      let document = await registry.read();
      let operation = ownedOperation(document, opId, caller);
      const { intent } = operation;
      if (operation.state === 'reserved') {
        await registry.update((current) => beginStep(current, opId, caller, 'session', now(), self));
        // A recreate follows a JSONL that never reached disk; the resident
        // session of that attempt must not be adopted again.
        let session = operation.recreate ? undefined : await findSessionByOperation({ opId, cwd: intent.cwd });
        if (!session) {
          try {
            session = await createWorkerSession({
              cwd: intent.cwd,
              title: intent.title,
              ...(intent.model ? { model: intent.model } : {}),
              ...(intent.thinking ? { thinking: intent.thinking } : {}),
              parentSessionPath: runtime.session.sessionFile,
              lineage: {
                parentSessionId: caller,
                parentDirectory: runtime.cwd,
                opId,
                ...(intent.role ? { role: intent.role } : {}),
              },
            });
          } catch (error) {
            // The session may exist although the create call failed late.
            session = await findSessionByOperation({ opId, cwd: intent.cwd });
            if (!session) {
              await registry.update((current) => failOperation(current, opId, caller, 'session', error?.message ?? String(error), now()))
                .catch(() => {});
              throw error;
            }
          }
        }
        await registry.update((current) => recordSession(current, opId, caller, session, now()));
        document = await registry.read();
        operation = ownedOperation(document, opId, caller);
      }
      const { sessionId } = operation;
      if (!operation.steps.prompted?.doneAt && document.workers[sessionId]) {
        await registry.update((current) => beginStep(current, opId, caller, 'prompted', now(), self));
        const receipt = await startTask(sessionId, intent.brief, 'prompt', `${opId}.task`);
        await registry.update((current) => {
          finishStep(ownedOperation(current, opId, caller), 'prompted', now(), receipt?.messageId ? { messageId: receipt.messageId } : {});
        });
        document = await registry.read();
      }
      return { sessionId, worker: document.workers[sessionId] };
    } finally {
      runningOperations.delete(opId);
    }
  };

  const spawnOnce = async (callerSessionId, runtime, args) => {
    if (typeof args.cwd !== 'string' || !isAbsolute(args.cwd)) {
      throw new OrchestrationError('INVALID_ARGUMENT', 'cwd must be an absolute directory.');
    }
    const settings = await readSettings();
    const known = args.clientRequestId
      ? (await registry.read()).requestKeys[requestKey(callerSessionId, args.clientRequestId)]
      : undefined;
    if (!known) {
      const busyHere = listLiveRuntimes().find((candidate) => lineageOf(candidate) && candidate.cwd === args.cwd
        && !isSettled(candidate.session.sessionId));
      if (busyHere) {
        throw new OrchestrationError('ORCHESTRATION_CWD_BUSY', 'A managed worker is busy in this directory; use another worktree.', {
          sessionId: busyHere.session.sessionId,
        });
      }
    }
    const { model, thinking } = await resolveModel(args, settings);
    const title = args.title?.trim() || args.task.trim().split(/\r?\n/)[0].slice(0, 80);
    const intent = {
      cwd: args.cwd,
      title,
      brief: `${workerPreamble(callerSessionId)}${args.task}`,
      ...(args.role ? { role: args.role } : {}),
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
    };
    const reserved = await registry.update((document) => {
      ensureOwner(document, callerSessionId, runtime.cwd);
      return reserveSpawn(document, {
        caller: callerSessionId,
        clientRequestId: args.clientRequestId,
        intent,
        workerLimit: settings.workerLimit,
        opId: `op_${randomUUID()}`,
        at: now(),
        process: self,
      });
    });
    const result = await runOperation(reserved.opId, callerSessionId, runtime);
    return { ...result, deduplicated: reserved.resumed };
  };

  const spawn = async (callerSessionId, args, options, context) => {
    let outcome;
    const key = args.clientRequestId ? `${callerSessionId}\u0000${args.clientRequestId}` : undefined;
    if (key && inflightSpawns.has(key)) {
      outcome = { ...await inflightSpawns.get(key), deduplicated: true };
    } else {
      const operation = spawnOnce(callerSessionId, context.runtime, args);
      if (key) inflightSpawns.set(key, operation);
      try {
        outcome = await operation;
      } finally {
        if (key) inflightSpawns.delete(key);
      }
    }
    const { sessionId, worker } = outcome;
    const result = {
      sessionId,
      cwd: worker?.cwd,
      title: worker?.title,
      ...(worker?.role ? { role: worker.role } : {}),
      ...(worker?.model ? { model: worker.model } : {}),
      ...(outcome.deduplicated ? { deduplicated: true } : {}),
    };
    if (args.mode === 'wait') {
      const waited = await wait(callerSessionId, { sessionIds: [sessionId], timeoutMs: args.timeoutMs }, options);
      return { ...result, ...waited.sessions[0], timedOut: waited.timedOut };
    }
    return { ...result, state: stateOf(sessionId) };
  };

  const list = async (callerSessionId, args = {}) => {
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
    const document = await registry.read();
    return {
      sessions: await Promise.all(workersOf(document, callerSessionId)
        .map(([sessionId, worker]) => describeWorker(sessionId, worker))),
    };
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

  // `stopping` holds the slot and suppresses the result delivery of the abort
  // settle; the worker becomes `stopped` once its abort returned.
  const stopTree = async (sessionId, stopped) => {
    if (stopped.includes(sessionId)) return;
    stopped.push(sessionId);
    pendingRuns.delete(sessionId);
    const children = await registry.update((document) => {
      const worker = document.workers[sessionId];
      if (worker) worker.stopping = self;
      return workersOf(document, sessionId, { includeStopped: false }).map(([childId]) => childId);
    });
    for (const childId of children) await stopTree(childId, stopped);
    await abortSession(sessionId).catch(() => {});
    await registry.update((document) => {
      const worker = document.workers[sessionId];
      if (!worker) return;
      delete worker.stopping;
      delete worker.doneReported;
      delete worker.gate;
      worker.state = 'stopped';
      worker.stateSince = now();
    });
  };

  const stop = async (_callerSessionId, args) => {
    const worker = (await registry.read()).workers[args.sessionId];
    if (worker?.state === 'stopped') return { sessionId: args.sessionId, stopped: [], alreadyStopped: true };
    const stopped = [];
    await stopTree(args.sessionId, stopped);
    notifyWaiters();
    return { sessionId: args.sessionId, stopped };
  };

  const takeover = async (callerSessionId, args, _options, context) => {
    const from = args.fromSessionId;
    if (from === callerSessionId) {
      throw new OrchestrationError('INVALID_ARGUMENT', 'An orchestrator cannot take over from itself.');
    }
    const busyStep = [...runningOperations.values()].includes(from);
    if (busyStep || !isSettled(from)) {
      throw new OrchestrationError('ORCHESTRATION_TAKEOVER_BUSY', busyStep
        ? 'A start of that orchestrator is still running; retry when it finished.'
        : 'That orchestrator is still running; interrupt it or wait until it is idle.', { sessionId: from });
    }
    const fromRuntime = getLiveRuntime(from) ?? await activateSession(from).catch(() => undefined);
    if (fromRuntime && !lineageOf(fromRuntime)) await ensureImported(from, fromRuntime);
    const moved = await registry.update((document) => {
      ensureOwner(document, callerSessionId, context.runtime.cwd);
      return takeOver(document, { from, to: callerSessionId, at: now() });
    });
    return { fromSessionId: from, workers: moved.workers, operations: moved.operations };
  };

  const handlers = {
    orchestration_capabilities: capabilities,
    session_spawn: spawn,
    session_list: list,
    session_read: read,
    session_send: send,
    session_wait: wait,
    session_interrupt: interrupt,
    session_stop: stop,
    orchestration_takeover: takeover,
  };

  /**
   * Execute one tool as `callerSessionId`. Arguments are validated by the
   * adapter against the shared JSON Schema contracts; the policy decides
   * before any side effect.
   */
  const call = async (callerSessionId, toolName, args = {}, options = {}) => {
    if (!toolByName.has(toolName)) {
      throw new OrchestrationError('UNKNOWN_TOOL', `Unknown orchestration tool: ${toolName}`);
    }
    if (typeof callerSessionId !== 'string' || callerSessionId.length === 0) {
      throw new OrchestrationError('SESSION_NOT_FOUND', 'The calling session is unknown.');
    }
    await reconciled();
    const runtime = await callerRuntime(callerSessionId);
    const callerKind = lineageOf(runtime) ? 'worker' : 'orchestrator';
    if (callerKind === 'orchestrator') await ensureImported(callerSessionId, runtime);
    const targetOwner = needsOwnership(toolName)
      ? (await registry.read()).workers[args?.sessionId]?.orchestratorSessionId ?? null
      : undefined;
    authorize({ toolName, callerSessionId, callerKind, targetOwner });
    return handlers[toolName](callerSessionId, args ?? {}, options, { runtime, callerKind });
  };

  const deliverResult = async (sessionId, runtime, worker, ownerCwd) => {
    const owner = worker.orchestratorSessionId;
    const parent = getLiveRuntime(owner) ?? await activateSession(owner, ownerCwd);
    const assistant = lastAssistant(runtime);
    const outcome = outcomeOf(assistant);
    const reply = truncate(textOf(assistant?.content), RESULT_TEXT_LIMIT);
    const title = runtime.session.sessionManager?.getSessionName?.() || worker.title;
    const header = `Worker "${title}" (${sessionId}) ${outcome === 'completed' ? 'finished' : outcome === 'interrupted' ? 'was interrupted' : 'failed'}.`;
    await parent.session.sendCustomMessage({
      customType: RESULT_MESSAGE,
      content: [header, assistant?.errorMessage ? `Error: ${assistant.errorMessage}` : '', reply].filter(Boolean).join('\n\n'),
      display: true,
      details: { sessionId, title, cwd: runtime.cwd, outcome, ...(worker.role ? { role: worker.role } : {}) },
    }, { triggerTurn: true, deliverAs: 'followUp' });
  };

  /**
   * Called by the daemon for every agent_settled. Applies the worker's state
   * transition, resolves waits and delivers a worker's result to its current
   * owner as a custom message that starts a turn, or queues as follow-up
   * while the owner is busy.
   */
  const onSessionSettled = async (sessionId, runtime) => {
    pendingRuns.delete(sessionId);
    notifyWaiters();
    const lineage = lineageOf(runtime);
    let document = await registry.read();
    if (!document.workers[sessionId] && lineage?.parentSessionId && !imported.has(lineage.parentSessionId)) {
      const parent = getLiveRuntime(lineage.parentSessionId)
        ?? await activateSession(lineage.parentSessionId, lineage.parentDirectory);
      await ensureImported(lineage.parentSessionId, parent);
      document = await registry.read();
    }
    if (!document.workers[sessionId]) return;
    await reconciled();
    document = await registry.read();
    if (!document.workers[sessionId]) return;
    const presence = document.workers[sessionId].state === 'starting'
      ? await sessionFileState(sessionId, document.workers[sessionId].sessionFile)
      : undefined;
    const settled = await registry.update((current) => {
      const state = applySettle(current, sessionId, presence, now());
      const worker = current.workers[sessionId];
      return { state, worker: worker ? { ...worker } : undefined, ownerCwd: current.owners[worker?.orchestratorSessionId]?.cwd };
    });
    if (!settled.worker || settled.worker.stopping || settled.state === 'stopped') return;
    await deliverResult(sessionId, runtime, settled.worker, settled.ownerCwd ?? lineage?.parentDirectory);
  };

  /**
   * Input gate, called by the daemon's one input path before it activates a
   * session. A `done` or `stopped` worker reserves its slot here, unless a run
   * is live (steer and follow-up need no slot). The returned ticket goes back
   * to `afterSessionInput` once the input started a run or ended without one.
   */
  const beforeSessionInput = async (sessionId) => {
    inputsInFlight.set(sessionId, (inputsInFlight.get(sessionId) ?? 0) + 1);
    try {
      if (!(await registry.read()).workers[sessionId]) return { token: null };
      await reconciled();
      const worker = (await registry.read()).workers[sessionId];
      if (!worker || (worker.state !== 'done' && worker.state !== 'stopped') || hasLiveRun(sessionId)) return { token: null };
      const { workerLimit } = await readSettings();
      const token = await registry.update((document) => reserveForInput(document, sessionId, { workerLimit, token: randomUUID(), at: now(), process: self }));
      return { token };
    } catch (error) {
      inputDone(sessionId);
      throw error;
    }
  };

  const inputDone = (sessionId) => {
    const remaining = (inputsInFlight.get(sessionId) ?? 1) - 1;
    if (remaining > 0) inputsInFlight.set(sessionId, remaining);
    else inputsInFlight.delete(sessionId);
  };

  // The slot returns only when this input started no run, no run is live and
  // no parallel input is still on its way (it may yet start one, R3-S1).
  const afterSessionInput = async (sessionId, ticket, { startedRun = false } = {}) => {
    inputDone(sessionId);
    const token = ticket?.token;
    if (!token) return;
    const keep = startedRun || hasLiveRun(sessionId) || inputsInFlight.has(sessionId);
    await registry.update((document) => (keep
      ? keepInput(document, sessionId, token)
      : releaseInput(document, sessionId, token, now())));
  };

  /**
   * A worker reported `done` in its current run. The worker becomes `done`,
   * and its slot free, when that run settles; the run may still call tools.
   */
  const recordDoneReport = (sessionId) => registry.update((document) => {
    const worker = document.workers[sessionId];
    if (!worker || (worker.state !== 'active' && worker.state !== 'starting')) return false;
    worker.doneReported = true;
    return true;
  });

  // The restart check runs once per process, before the first use that
  // touches the registry, not at daemon start: a daemon that never
  // orchestrates never writes the registry.
  let reconciling;
  const reconciled = () => {
    reconciling ??= reconcile().catch((error) => {
      reconciling = undefined;
      throw error;
    });
    return reconciling;
  };

  /**
   * After a restart: adopt or release reserved starts, check `starting` workers
   * against the disk, and finish what a crash interrupted (a stop, an input
   * gate). No run is live after a restart.
   */
  const reconcile = async () => {
    const document = await registry.read();
    for (const [opId, operation] of Object.entries(document.operations)) {
      if (operation.state !== 'reserved' || operation.recreate || belongsToLiveProcess(operation.process)) continue;
      const session = await findSessionByOperation({ opId, cwd: operation.intent?.cwd });
      await registry.update((current) => {
        const live = current.operations[opId];
        if (live?.state !== 'reserved' || live.recreate) return;
        if (session) {
          recordSession(current, opId, live.orchestratorSessionId, session, now());
          return;
        }
        live.state = 'abandoned';
        live.stateSince = now();
      });
    }
    const workers = Object.entries((await registry.read()).workers);
    for (const [sessionId, worker] of workers) {
      const checkStart = worker.state === 'starting' && !belongsToLiveProcess(worker.process);
      const presence = checkStart ? await sessionFileState(sessionId, worker.sessionFile) : undefined;
      await registry.update((current) => {
        const live = current.workers[sessionId];
        if (!live) return;
        if (presence && live.state === 'starting') applyDurability(current, sessionId, presence, now());
        if (live.gate && !belongsToLiveProcess(live.gate.process)) releaseInput(current, sessionId, live.gate.token, now());
        if (live.stopping && !belongsToLiveProcess(live.stopping)) {
          delete live.stopping;
          live.state = 'stopped';
          live.stateSince = now();
        }
      });
    }
  };

  return {
    call,
    onSessionSettled,
    beforeSessionInput,
    afterSessionInput,
    recordDoneReport,
    isWorker: (sessionManager) => Boolean(lineageOf({ session: { sessionManager } })),
    toolNames: ORCHESTRATION_TOOL_NAMES,
  };
}
