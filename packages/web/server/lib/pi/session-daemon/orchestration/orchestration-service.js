import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { schemaViolation } from './contract-validator.js';
import { OrchestrationError } from './errors.js';
import { workerPreamble } from './instructions.js';
import { authorize, needsOwnership } from './policy.js';
import { PROCESS_INSTANCE, createProcessIdentity, isPidAlive, readProcessStartTime } from './process-identity.js';
import { ORCHESTRATION_TOOL_NAMES, ORCHESTRATION_TOOLS } from './tool-contracts.js';
import {
  applyDurability,
  admitForInput,
  applySettle,
  beginStep,
  commitStart,
  ensureOwner,
  failOperation,
  finishStep,
  importLineage,
  markUnresolved,
  ownedOperation,
  recordSession,
  rejectStart,
  releaseAdmission,
  requestKey,
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
    holdSession = () => () => {},
    // 'present' | 'absent' | 'unknown' for the worker's JSONL.
    sessionFileState = async () => 'unknown',
    // A live session created for this start operation, if any.
    findSessionByOperation = async () => undefined,
    now = () => Date.now(),
    // Canonical form of a worker directory, so spellings share one lock.
    canonicalDirectory = async (directory) => directory,
    onDeliveryFailed = () => {},
    // An admitted input whose outcome could not be recorded keeps its slot;
    // the daemon reports it to the session.
    onAdmissionUnresolved = () => {},
    delay = (ms) => new Promise((done) => { setTimeout(done, ms); }),
    processId = process.pid,
    processInstance = PROCESS_INSTANCE,
    isProcessAlive = isPidAlive,
    processStartTime = readProcessStartTime,
  } = deps;

  // Several daemons can share one data root. Every transitional record
  // names the process that drives it, so the restart check of one process
  // never finishes what a live other process is still doing.
  const { self, isLive: belongsToLiveProcess, isMine } = createProcessIdentity({
    pid: processId,
    instance: processInstance,
    isAlive: isProcessAlive,
    startTimeOf: processStartTime,
  });

  // Runs this service started that have not settled yet. A run accepted by
  // Pi may not have emitted agent_start yet, so live streaming state alone
  // would let a wait return before the run began.
  // Each send holds its own token until its run settles, so a retry that
  // only returns a stored receipt never releases a newer send's pending run.
  const pendingRuns = new Map();
  const waiters = new Set();
  // In-process guards only; the registry is the durable record.
  const inflightSpawns = new Map();
  const runningOperations = new Map();
  // Admitted inputs per session by token (see `admitInput`).
  const tickets = new Map();
  // Generation of the run this service started last, per worker.
  const runGenerations = new Map();
  // A settle whose `done` rule waits for the admitted inputs, per worker.
  const deferredSettles = new Map();
  // Stops running in this service per worker; a second stop shares the first.
  const stopsInFlight = new Map();
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

  // Holds a target session's idle guard for the whole use, so a session
  // opened here is not disposed mid-use and is disposed again when idle.
  const withSession = async (sessionId, use) => {
    const release = holdSession(sessionId);
    try {
      return await use();
    } finally {
      release();
    }
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
    if (!runtime) throw new OrchestrationError(CALLER_GONE, 'The calling session no longer exists.');
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
        // A recreate follows a JSONL that never reached disk; the sessions it
        // replaced must not be adopted again, by either lookup.
        const exclude = operation.replaced ?? [];
        let session = operation.recreate ? undefined : await findSessionByOperation({ opId, cwd: intent.cwd, exclude });
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
            // The session may exist although the create call failed late. An
            // undecided lookup keeps the reservation for a retry.
            session = await findSessionByOperation({ opId, cwd: intent.cwd, exclude }).catch(() => { throw error; });
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
      if (!operation.steps.prompted?.doneAt && document.workers[sessionId]) await withSession(sessionId, async () => {
        // A prompt step that began before a crash may have been accepted;
        // send receipts do not outlive the process, the transcript does.
        const accepted = operation.steps.prompted?.startedAt !== undefined && await taskAccepted(sessionId, intent);
        await registry.update((current) => beginStep(current, opId, caller, 'prompted', now(), self));
        let receipt;
        if (!accepted) {
          try {
            receipt = await startTask(sessionId, intent.brief, 'prompt', `${opId}.task`);
          } catch (error) {
            await registry.update((current) => rejectStart(current, opId, caller, error?.message ?? String(error), now()))
              .catch(() => {});
            throw error;
          }
        }
        await registry.update((current) => {
          finishStep(ownedOperation(current, opId, caller), 'prompted', now(), accepted
            ? { recovered: true }
            : receipt?.messageId ? { messageId: receipt.messageId } : {});
        });
        document = await registry.read();
      });
      return { sessionId, worker: document.workers[sessionId] };
    } catch (error) {
      // The step ended without finishing; a takeover need not wait for it.
      await registry.update((current) => {
        const live = current.operations[opId];
        const step = live?.orchestratorSessionId === caller ? live.steps?.[live.step] : undefined;
        if (step?.startedAt !== undefined && step.doneAt === undefined) step.endedAt = now();
      }).catch(() => {});
      throw error;
    } finally {
      runningOperations.delete(opId);
    }
  };

  // Whether the transcript already holds this start's task, so a resumed
  // prompt step must not send it again. Only a user message with the task's
  // text counts. A deleted session cannot have it; a transcript that cannot
  // be read now leaves the start open for a retry instead of sending blind.
  const taskAccepted = async (sessionId, intent) => {
    let runtime = getLiveRuntime(sessionId);
    if (!runtime) {
      try {
        runtime = await activateSession(sessionId, intent.cwd);
      } catch (error) {
        if (isGone(error)) return false;
        throw new OrchestrationError('ORCHESTRATION_START_UNDECIDED', 'The worker transcript cannot be checked for the task right now; retry the spawn.', {
          sessionId,
          ...(typeof error?.code === 'string' ? { cause: error.code } : {}),
        });
      }
    }
    const task = intent.brief.trim();
    return (runtime?.session?.messages ?? [])
      .some((message) => message?.role === 'user' && textOf(message.content).trim() === task);
  };

  const spawnOnce = async (callerSessionId, runtime, args) => {
    if (typeof args.cwd !== 'string' || !isAbsolute(args.cwd)) {
      throw new OrchestrationError('INVALID_ARGUMENT', 'cwd must be an absolute directory.');
    }
    const settings = await readSettings();
    // The registry holds the directory with the slot; spellings fold here.
    const cwd = await canonicalDirectory(args.cwd);
    const { model, thinking } = await resolveModel(args, settings);
    const title = args.title?.trim() || args.task.trim().split(/\r?\n/)[0].slice(0, 80);
    const intent = {
      cwd,
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

  const read = (callerSessionId, args) => withSession(args.sessionId, () => readSession(callerSessionId, args));

  const readSession = async (_callerSessionId, args) => {
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

  const send = (callerSessionId, args) => withSession(args.sessionId, () => sendSession(callerSessionId, args));

  const sendSession = async (_callerSessionId, args) => {
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
      if (!getLiveRuntime(sessionId)) await withSession(sessionId, () => activateSession(sessionId));
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
    await withSession(args.sessionId, () => abortSession(args.sessionId));
    return { sessionId: args.sessionId, interrupted: true };
  };

  // Stops the worker and its own workers, deepest first. `stopping` holds the
  // slot and suppresses the result of the abort settle. A worker becomes
  // `stopped`, and frees its slot, only after its abort succeeded or the
  // session no longer exists. A failed abort, for example of a worker resident
  // in another daemon, keeps the worker and its slot, and its ancestors keep
  // running, so a retry can finish the stop.
  // The claim is fenced: it is taken only while `owner` still owns the worker,
  // and only the claim's own token may finish or release it.
  // A stop of a worker that this service is already stopping shares that
  // stop instead of replacing its claim; the caller gets its outcome.
  const stopTree = async (sessionId, owner, result) => {
    if (result.stopped.includes(sessionId)) return true;
    let running = stopsInFlight.get(sessionId);
    if (running && (await registry.read()).workers[sessionId]?.orchestratorSessionId !== owner) {
      throw new OrchestrationError('ORCHESTRATION_OWNER_CHANGED', 'This worker now belongs to another orchestrator.', { sessionId });
    }
    if (!running) {
      running = stopOne(sessionId, owner).finally(() => stopsInFlight.delete(sessionId));
      stopsInFlight.set(sessionId, running);
    }
    const outcome = await running;
    for (const id of outcome.stopped) if (!result.stopped.includes(id)) result.stopped.push(id);
    result.failed.push(...outcome.failed);
    return outcome.ok;
  };

  const stopOne = async (sessionId, owner) => {
    const result = { stopped: [], failed: [] };
    const claim = { ...self, token: randomUUID() };
    const children = await registry.update((document) => {
      const worker = document.workers[sessionId];
      if (worker) {
        if (worker.orchestratorSessionId !== owner) {
          throw new OrchestrationError('ORCHESTRATION_OWNER_CHANGED', 'This worker now belongs to another orchestrator.', { sessionId });
        }
        // A live claim of another service is a stop still running there and
        // is never replaced. A dead one is reconcile's; one of this service
        // without a running stop is stale.
        if (worker.stopping && worker.stopping.service !== self.service && belongsToLiveProcess(worker.stopping)) return null;
        worker.stopping = claim;
      }
      return workersOf(document, sessionId, { includeStopped: false }).map(([childId]) => childId);
    });
    if (children === null) {
      result.failed.push({ sessionId, code: 'ORCHESTRATION_STOP_BUSY' });
      return { ok: false, ...result };
    }
    const holdsClaim = (worker) => worker?.stopping?.token === claim.token;
    let failure;
    for (const childId of children) {
      if (!await stopTree(childId, sessionId, result)) failure = 'ORCHESTRATION_DESCENDANT_STOP_FAILED';
    }
    if (!failure) {
      // Inputs admitted before the claim get their outcome first, so a run
      // one of them starts is aborted too; later inputs are refused. An
      // unresolved input is not waited for: a run it starts later finds
      // the worker stopped and is aborted then.
      await openTicketsDone(sessionId);
      try {
        await withSession(sessionId, () => abortSession(sessionId));
      } catch (error) {
        if (!isGone(error)) failure = typeof error?.code === 'string' ? error.code : 'ABORT_FAILED';
      }
    }
    if (failure) {
      result.failed.push({ sessionId, code: failure });
      await registry.update((document) => {
        const worker = document.workers[sessionId];
        if (holdsClaim(worker)) delete worker.stopping;
      });
      return { ok: false, ...result };
    }
    // Only the claim's holder marks the worker stopped and reports it.
    const marked = await registry.update((document) => {
      const worker = document.workers[sessionId];
      if (!worker) return true;
      if (!holdsClaim(worker)) return false;
      delete worker.stopping;
      delete worker.doneReported;
      delete worker.admission;
      worker.state = 'stopped';
      worker.stateSince = now();
      return true;
    });
    if (!marked) {
      result.failed.push({ sessionId, code: 'ORCHESTRATION_STOP_CLAIM_LOST' });
      return { ok: false, ...result };
    }
    pendingRuns.delete(sessionId);
    deferredSettles.delete(sessionId);
    result.stopped.push(sessionId);
    return { ok: true, ...result };
  };

  const stop = async (callerSessionId, args) => {
    const worker = (await registry.read()).workers[args.sessionId];
    if (worker?.state === 'stopped') return { sessionId: args.sessionId, stopped: [], alreadyStopped: true };
    const result = { stopped: [], failed: [] };
    await stopTree(args.sessionId, callerSessionId, result);
    notifyWaiters();
    if (result.failed.length > 0) {
      throw new OrchestrationError('ORCHESTRATION_STOP_FAILED', 'Some workers could not be aborted and keep running; retry session_stop.', {
        sessionId: args.sessionId,
        ...result,
      });
    }
    return { sessionId: args.sessionId, stopped: result.stopped };
  };

  const takeover = async (callerSessionId, args, _options, context) => {
    const from = args.fromSessionId;
    if (from === callerSessionId) {
      throw new OrchestrationError('INVALID_ARGUMENT', 'An orchestrator cannot take over from itself.');
    }
    // Only a session resident here can be proven idle. One that is resident
    // in another daemon (SESSION_IN_USE) or cannot be checked is not idle; a
    // deleted one has no run left.
    let fromRuntime = getLiveRuntime(from);
    if (!fromRuntime) {
      try {
        fromRuntime = await withSession(from, () => activateSession(from));
      } catch (error) {
        if (!isGone(error)) {
          throw new OrchestrationError('ORCHESTRATION_TAKEOVER_BUSY', 'That orchestrator cannot be checked here, it may still run in another PiChamber instance.', {
            sessionId: from,
            ...(typeof error?.code === 'string' ? { cause: error.code } : {}),
          });
        }
      }
    }
    if (fromRuntime && !isSettled(from)) {
      throw new OrchestrationError('ORCHESTRATION_TAKEOVER_BUSY', 'That orchestrator is still running; interrupt it or wait until it is idle.', { sessionId: from });
    }
    if (fromRuntime && !lineageOf(fromRuntime)) await ensureImported(from, fromRuntime);
    // A start step in flight blocks the takeover: here when this service runs
    // it, elsewhere while the process that began it lives.
    const isRunning = (opId, operation) => (isMine(operation.process)
      ? runningOperations.has(opId)
      : belongsToLiveProcess(operation.process));
    // A stop claim of a live process is still aborting that worker.
    const isStopping = (stamp) => stamp !== undefined && belongsToLiveProcess(stamp);
    const moved = await registry.update((document) => {
      ensureOwner(document, callerSessionId, context.runtime.cwd);
      return takeOver(document, { from, to: callerSessionId, at: now(), isRunning, isStopping });
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
   * Execute one tool as `callerSessionId`. The arguments are validated here
   * against the shared contracts, so both adapters get the same bounds; the
   * caller must still exist, and the policy decides before any side effect.
   */
  const call = async (callerSessionId, toolName, args = {}, options = {}) => {
    const tool = toolByName.get(toolName);
    if (!tool) {
      throw new OrchestrationError('UNKNOWN_TOOL', `Unknown orchestration tool: ${toolName}`);
    }
    if (typeof callerSessionId !== 'string' || callerSessionId.length === 0) {
      throw new OrchestrationError('SESSION_NOT_FOUND', 'The calling session is unknown.');
    }
    const violation = schemaViolation(tool.parameters, args ?? {});
    if (violation) throw new OrchestrationError('INVALID_ARGUMENT', violation);
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

  // The recipient of a worker's result, read from the registry at each
  // delivery: the current owner, or none once the worker is stopping, stopped
  // or gone. The result itself stays the settled turn's.
  const resultRecipient = async (sessionId, lineage) => {
    const document = await registry.read();
    const worker = document.workers[sessionId];
    if (!worker || worker.stopping || worker.state === 'stopped' || worker.state === 'removed') return undefined;
    const owner = worker.orchestratorSessionId;
    const cwd = document.owners[owner]?.cwd ?? (owner === lineage?.parentSessionId ? lineage.parentDirectory : undefined);
    return { owner, cwd, worker };
  };

  // A parent that cannot be reached is retried with backoff. Every decision
  // is taken against a registry read that succeeded: a stopped or removed
  // worker ends the delivery silently, an owner change goes on at once with
  // the new owner and its own attempts, a deleted current owner drops the
  // result, and a final failure is reported for the current owner through
  // onDeliveryFailed. A failed read confirms no recipient, old or new; it is
  // retried with backoff and, after the last try, reported as it is. Every
  // owner change the loop sees counts against one budget, also one that flips
  // back before the next read.
  const deliverWithRetry = async (sessionId, result, lineage) => {
    let owner;
    let ownerCwd;
    let attempts = 0;
    let ownerChanges = 0;
    let readFailures = 0;
    // The failed attempt to `owner`, judged against the next successful read.
    let failure;
    const read = () => resultRecipient(sessionId, lineage).then((recipient) => ({ recipient }), (error) => ({ error }));
    const report = (error) => onDeliveryFailed({
      sessionId,
      parentSessionId: owner ?? lineage?.parentSessionId,
      parentDirectory: ownerCwd ?? lineage?.parentDirectory,
      error,
    });
    let next = await read();
    for (;;) {
      if (next.error) {
        readFailures += 1;
        if (readFailures >= DELIVERY_ATTEMPTS) {
          report(next.error);
          return;
        }
        await delay(DELIVERY_RETRY_MS * 2 ** (readFailures - 1));
        next = await read();
        continue;
      }
      readFailures = 0;
      const { recipient } = next;
      if (!recipient) return;
      if (owner !== undefined && recipient.owner !== owner) {
        ownerChanges += 1;
        attempts = 0;
        // A failure of the old owner says nothing about the new one.
        failure = undefined;
      }
      ({ owner, cwd: ownerCwd } = recipient);
      if (ownerChanges > DELIVERY_ATTEMPTS) {
        report(new OrchestrationError('ORCHESTRATION_OWNER_CHANGED', 'The worker kept changing its owner during delivery.', { sessionId }));
        return;
      }
      if (failure) {
        // `owner` is still the recipient, so the failure is its own.
        if (isGone(failure)) return;
        attempts += 1;
        if (attempts >= DELIVERY_ATTEMPTS) {
          report(failure);
          return;
        }
        failure = undefined;
        await delay(DELIVERY_RETRY_MS * 2 ** (attempts - 1));
        next = await read();
        continue;
      }
      try {
        // The owner's guard covers its activation and the send until Pi
        // accepted it, but not the backoff between attempts. A recipient read
        // in it that differs is decided by the loop like any other read.
        next = await withSession(owner, async () => {
          const parent = getLiveRuntime(owner) ?? await activateSession(owner, ownerCwd);
          const current = await resultRecipient(sessionId, lineage);
          if (current?.owner !== owner) return { recipient: current };
          await deliverResult(parent, sessionId, result, current.worker);
          return { delivered: true };
        });
        if (next.delivered) return;
      } catch (error) {
        failure = error;
        next = await read();
      }
    }
  };

  const deliverResult = async (parent, sessionId, result, worker) => {
    const { assistant, cwd } = result;
    const outcome = outcomeOf(assistant);
    const reply = truncate(textOf(assistant?.content), RESULT_TEXT_LIMIT);
    const title = result.title || worker.title;
    const header = `Worker "${title}" (${sessionId}) ${outcome === 'completed' ? 'finished' : outcome === 'interrupted' ? 'was interrupted' : 'failed'}.`;
    await parent.session.sendCustomMessage({
      customType: RESULT_MESSAGE,
      content: [header, assistant?.errorMessage ? `Error: ${assistant.errorMessage}` : '', reply].filter(Boolean).join('\n\n'),
      display: true,
      details: { sessionId, title, cwd, outcome, ...(worker.role ? { role: worker.role } : {}) },
    }, { triggerTurn: true, deliverAs: 'followUp' });
  };

  /**
   * Called by the daemon for every agent_settled. Applies the worker's state
   * transition, resolves waits and delivers a worker's result to its current
   * owner as a custom message that starts a turn, or queues as follow-up
   * while the owner is busy.
   * The `done` rule applies only to the generation that settled. While an
   * admitted input has no outcome yet it waits, because that input may start
   * the next run in the same slot (`resolveInput` applies or drops it).
   */
  const onSessionSettled = async (sessionId, runtime) => {
    pendingRuns.delete(sessionId);
    notifyWaiters();
    // The settled turn's result and generation, taken before any await: a
    // later turn of the worker must not replace them while the settle or a
    // delivery retry waits.
    const result = {
      assistant: lastAssistant(runtime),
      title: runtime.session.sessionManager?.getSessionName?.(),
      cwd: runtime.cwd,
    };
    const generation = runGenerations.get(sessionId) ?? null;
    expireUnresolved(sessionId);
    const lineage = lineageOf(runtime);
    let document = await registry.read();
    if (!document.workers[sessionId] && lineage?.parentSessionId && !imported.has(lineage.parentSessionId)) {
      await withSession(lineage.parentSessionId, async () => {
        const parent = getLiveRuntime(lineage.parentSessionId)
          ?? await activateSession(lineage.parentSessionId, lineage.parentDirectory);
        await ensureImported(lineage.parentSessionId, parent);
      });
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
      const hold = (tickets.get(sessionId)?.size ?? 0) > 0;
      // With no admitted input left, an admission this process still shows
      // (unresolved, or kept after a failed commit) ends with the run.
      if (!hold) releaseAdmission(current, sessionId, now(), ownsAdmission);
      const state = applySettle(current, sessionId, presence, now(), { generation, hold });
      if (hold) deferredSettles.set(sessionId, { generation });
      const worker = current.workers[sessionId];
      return { state, worker: worker ? { ...worker } : undefined };
    });
    if (!settled.worker || settled.worker.stopping || settled.state === 'stopped') return;
    await deliverWithRetry(sessionId, result, lineage);
  };

  /*
   * Input admission. The daemon's one input path calls `beforeSessionInput`
   * before it activates a session, `admitInput` once it holds the session's
   * lease right before the prompt, and `resolveInput` with Pi's verdict on
   * that prompt. Only the admission decides about a slot, and only Pi's
   * verdict ends it:
   * - `started`: the run takes the slot as a new generation (`commitStart`).
   * - `queued`, `handled`, `rejected`: no run; once no admitted input of the
   *   worker is left, a slot the admission took goes back and a settle that
   *   waited for the inputs applies.
   * - `unresolved`: Pi accepted the prompt without a verdict (a prompt
   *   deferred while the previous run settles). Nothing is rolled back: the
   *   slot stays and the registry shows `admission.state: 'unresolved'`
   *   until a late verdict, a stop, or the settle of the run it may have
   *   started.
   */
  const ticketsOf = (sessionId) => [...(tickets.get(sessionId)?.values() ?? [])];
  const openTicketsDone = async (sessionId) => {
    let open = ticketsOf(sessionId).filter((ticket) => ticket.state === 'open');
    while (open.length > 0) {
      await Promise.all(open.map((ticket) => ticket.decided));
      open = ticketsOf(sessionId).filter((ticket) => ticket.state === 'open');
    }
  };
  // An unresolved input is over once the run it may have started settled;
  // that is the second settle it sees at the latest (the first may be the
  // one it was deferred behind).
  const expireUnresolved = (sessionId) => {
    for (const ticket of ticketsOf(sessionId)) {
      if (ticket.state !== 'unresolved') continue;
      ticket.settles += 1;
      if (ticket.settles >= 2) tickets.get(sessionId).delete(ticket.token);
    }
    if (tickets.get(sessionId)?.size === 0) tickets.delete(sessionId);
  };
  const ownsAdmission = (process) => sameStamp(process, self);

  // Reads the registry for an input. A broken registry must not block
  // sessions that are provably no workers; a worker or an undecided session
  // fails closed. Returns null for a session that is no worker.
  const readForInput = async (sessionId) => {
    let document;
    try {
      document = await registry.read();
    } catch (error) {
      const runtime = getLiveRuntime(sessionId) ?? await activateSession(sessionId).catch(() => undefined);
      if (runtime && !lineageOf(runtime)) return null;
      throw error;
    }
    if (!document.workers[sessionId]) return null;
    await reconciled();
    return (await registry.read()).workers[sessionId] ?? null;
  };

  const workerStopping = (sessionId) => new OrchestrationError(
    'ORCHESTRATION_WORKER_STOPPING',
    'This worker is being stopped; retry once session_stop has finished.',
    { sessionId },
  );

  // Fails fast before the daemon activates a session; decides nothing.
  const beforeSessionInput = async (sessionId) => {
    const worker = await readForInput(sessionId);
    if (worker?.stopping) throw workerStopping(sessionId);
  };

  /**
   * Admits an input to a worker. Called by the daemon that holds the
   * session's lease, right before the prompt; returns the ticket for
   * `resolveInput`, or null for a session that is no worker.
   */
  const admitInput = async (sessionId) => {
    if (!await readForInput(sessionId)) return null;
    const { workerLimit } = await readSettings();
    const ticket = { sessionId, token: randomUUID(), state: 'open', settles: 0 };
    ticket.decided = new Promise((resolve) => { ticket.decide = resolve; });
    // Registered before the registry write, so a settle meanwhile waits.
    if (!tickets.has(sessionId)) tickets.set(sessionId, new Map());
    tickets.get(sessionId).set(ticket.token, ticket);
    let admitted;
    try {
      admitted = await registry.update((current) => admitForInput(current, sessionId, {
        workerLimit, token: ticket.token, at: now(), process: self, ownsProcess: ownsAdmission,
      }));
    } catch (error) {
      await closeTicket(ticket);
      throw error;
    }
    if (!admitted.worker) {
      await closeTicket(ticket);
      return null;
    }
    return ticket;
  };

  const reportUnresolved = (sessionId, error) => {
    try {
      onAdmissionUnresolved({ sessionId, error });
    } catch {
      // Reporting is best effort; the registry keeps the admission.
    }
  };

  // Ends a ticket without a run. The last one of the worker returns a slot
  // its admission took and applies a settle that waited for the inputs.
  const closeTicket = async (ticket) => {
    const { sessionId } = ticket;
    tickets.get(sessionId)?.delete(ticket.token);
    ticket.state = 'closed';
    ticket.decide();
    if ((tickets.get(sessionId)?.size ?? 0) > 0) return;
    tickets.delete(sessionId);
    const deferredSettle = deferredSettles.get(sessionId);
    deferredSettles.delete(sessionId);
    try {
      await registry.update((document) => {
        releaseAdmission(document, sessionId, now(), ownsAdmission);
        if (deferredSettle) applySettle(document, sessionId, undefined, now(), deferredSettle);
      });
    } catch (error) {
      reportUnresolved(sessionId, error);
    }
    if (deferredSettle) notifyWaiters();
  };

  /**
   * Pi's verdict on an admitted input: `started`, `queued` or `handled`
   * (preflight), `rejected`, or `unresolved` (accepted without a verdict). A
   * late verdict of an unresolved input still counts.
   */
  const resolveInput = async (ticket, outcome) => {
    if (!ticket || ticket.state === 'closed') return;
    const { sessionId } = ticket;
    if (outcome === 'unresolved') {
      if (ticket.state !== 'open') return;
      ticket.state = 'unresolved';
      ticket.decide();
      try {
        await registry.update((document) => markUnresolved(document, sessionId, { token: ticket.token, at: now(), process: self }));
      } catch (error) {
        reportUnresolved(sessionId, error);
      }
      return;
    }
    if (outcome !== 'started') {
      await closeTicket(ticket);
      return;
    }
    tickets.get(sessionId)?.delete(ticket.token);
    if ((tickets.get(sessionId)?.size ?? 0) === 0) tickets.delete(sessionId);
    ticket.state = 'closed';
    let committed;
    try {
      committed = await registry.update((document) => commitStart(document, sessionId, now()));
    } catch (error) {
      // No rollback: the admission keeps the slot for the run.
      reportUnresolved(sessionId, error);
      ticket.decide();
      return;
    }
    if (committed?.generation) {
      runGenerations.set(sessionId, committed.generation);
      // The waiting settle belonged to the previous run; this run keeps the slot.
      deferredSettles.delete(sessionId);
    }
    ticket.decide();
    // A worker stopped meanwhile has no slot for the run.
    if (committed?.stopped) await withSession(sessionId, () => abortSession(sessionId)).catch(() => {});
  };

  /**
   * A worker reported `done` in its current run. The worker becomes `done`,
   * and its slot free, when that run settles; the run may still call tools.
   */
  const recordDoneReport = (sessionId) => registry.update((document) => {
    const worker = document.workers[sessionId];
    if (!worker || (worker.state !== 'active' && worker.state !== 'starting')) return false;
    // Bound to the reporting run, so it never ends a later run.
    worker.doneReported = worker.generation ?? 0;
    return true;
  });

  // The check is lazy, not at daemon start: a daemon that never
  // orchestrates never writes the registry. It runs before each use that touches the registry, so a process
  // that dies later is still recovered (S2); concurrent uses share one pass.
  // It looks only at open transitions of dead processes, not the history.
  let reconciling;
  const reconciled = () => {
    reconciling ??= reconcile().finally(() => { reconciling = undefined; });
    return reconciling;
  };

  const sameStamp = (left, right) => left?.pid === right?.pid
    && left?.instance === right?.instance && left?.service === right?.service;

  /**
   * Recovery of transitions whose process died: adopt or release reserved
   * starts, check `starting` workers against the disk, and finish an
   * interrupted stop or input admission. Every change is bound to the stamp read
   * before it, so a transition another process claimed meanwhile stays (B3).
   */
  const reconcile = async () => {
    const document = await registry.read();
    for (const [opId, operation] of Object.entries(document.operations)) {
      if (operation.state !== 'reserved' || operation.recreate || belongsToLiveProcess(operation.process)) continue;
      let session;
      try {
        session = await findSessionByOperation({ opId, cwd: operation.intent?.cwd });
      } catch {
        // Undecided: the reservation stays for a later pass or a retry (S5).
        continue;
      }
      await registry.update((current) => {
        const live = current.operations[opId];
        if (live?.state !== 'reserved' || live.recreate || !sameStamp(live.process, operation.process)) return;
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
        // The file check applies only to the start it was made for; a start
        // another process claimed meanwhile stays.
        if (presence && live.state === 'starting' && sameStamp(live.process, worker.process)
          && !belongsToLiveProcess(live.process)) {
          applyDurability(current, sessionId, presence, now());
        }
        if (live.admission && !belongsToLiveProcess(live.admission.process)) releaseAdmission(current, sessionId, now(), () => true);
        // A stop whose process died may not have aborted the run: the worker
        // keeps its state and slot, and session_stop can be retried.
        if (live.stopping && !belongsToLiveProcess(live.stopping)) delete live.stopping;
      });
    }
  };

  return {
    call,
    onSessionSettled,
    beforeSessionInput,
    admitInput,
    resolveInput,
    recordDoneReport,
    onInputCompleted,
    verifyCaller,
    isWorker: (sessionManager) => Boolean(lineageOf({ session: { sessionManager } })),
    toolNames: ORCHESTRATION_TOOL_NAMES,
  };
}
