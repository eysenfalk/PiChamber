import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { schemaViolation } from './contract-validator.js';
import { OrchestrationError } from './errors.js';
import { hostGateNumbers } from './host-info.js';
import { workerPreamble } from './instructions.js';
import { authorize, needsOwnership } from './policy.js';
import { PROCESS_INSTANCE, createProcessIdentity, isPidAlive, readProcessStartTime } from './process-identity.js';
import { reportViolation } from './report-rules.js';
import { ORCHESTRATION_TOOL_NAMES, ORCHESTRATION_TOOLS } from './tool-contracts.js';
import { ROLE_PROFILES, TOOL_PROFILES, recordedProfile, resolveProfile } from './tool-profiles.js';
import { createPrWatch } from './pr-watch.js';
import { createWakes } from './wakes.js';
import {
  applyDurability,
  admitForInput,
  applySettle,
  beginStep,
  closeQuestion,
  completeStart,
  ensureOwner,
  failOperation,
  finishStep,
  importLineage,
  holdsStart,
  markUnresolved,
  ownedOperation,
  recordReport,
  recordSession,
  rejectStart,
  releaseHold,
  setHold,
  holdUnproven,
  releaseAdmission,
  requestKey,
  reserveSpawn,
  slotsInUse,
  takeOver,
} from './worker-registry.js';
import { prepareWorkerTree } from './worker-start.js';
import { cleanupRefusal } from './cleanup-guard.js';
import { readTreeState, removeWorkerTree, resolveCleanupTarget } from './worker-cleanup.js';

// Daemon-owned orchestration: tool semantics, permissions, limits, ownership,
// idempotency and wakes (`wakes.js`). Adapters (the in-process Pi extension
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
// #107 delivered a worker's final reply as this message; wakes replaced it.
// Kept so old transcripts still render.
export const RESULT_MESSAGE = 'pichamber.orchestration.result';

const READ_TEXT_LIMIT = 8 * 1024;
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 3_600_000;
// Codes with which the daemon reports a session that no longer exists.
const GONE_CODES = new Set(['INVALID_SESSION', 'SESSION_NOT_FOUND']);
// A lookup that failed on storage errors is marked `incomplete`: the
// session may still exist, so it is not treated as gone.
const isGone = (error) => GONE_CODES.has(error?.code) && error?.incomplete !== true;
// The session's file may exist but could not be read or looked up (#191): not gone, retry later.
const UNREADABLE_CODES = new Set(['MALFORMED_SESSION_JSONL', 'SESSION_JSONL_UNREADABLE']);
// The session a call acts as was deleted; adapters revoke its credentials.
export const CALLER_GONE = 'ORCHESTRATION_CALLER_GONE';

const customEntries = (runtime, customType) => {
  const entries = runtime?.session?.sessionManager?.getEntries?.() ?? [];
  return entries.filter((entry) => entry?.type === 'custom' && entry.customType === customType);
};

const lineageOf = (runtime) => customEntries(runtime, LINEAGE_ENTRY).at(-1)?.data;

// What a worker reports as its profile; one without a record runs `full`,
// null is a record that cannot be read (the worker runs fail closed).
const profileView = (profile) => (profile === undefined ? resolveProfile({ profile: 'full' }) : profile);

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

const ERROR_TEXT_LIMIT = 500;

/** Pi's session totals, or null when it reports none or a value is no finite count. */
const usageOf = (runtime) => {
  let stats;
  try {
    stats = runtime.session.getSessionStats?.();
  } catch {
    return null;
  }
  const { input, output, cacheRead, cacheWrite } = stats?.tokens ?? {};
  const usage = { input, output, cacheRead, cacheWrite, cost: stats?.cost };
  return Object.values(usage).every((value) => Number.isFinite(value) && value >= 0) ? usage : null;
};

/**
 * What must survive the runtime's disposal, taken from the runtime that just
 * settled: last transcript change, the error of the last turn, usage totals.
 */
const settleSnapshot = (runtime, at) => {
  const assistant = lastAssistant(runtime);
  const error = typeof assistant?.errorMessage === 'string' ? assistant.errorMessage : undefined;
  return {
    at,
    lastProgressAt: lastTimestamp(runtime) ?? null,
    lastError: error
      ? { message: truncate(error, ERROR_TEXT_LIMIT), at: Number.isFinite(assistant.timestamp) ? assistant.timestamp : at }
      : null,
    usage: usageOf(runtime),
  };
};

const DIGEST_OPERATION_STATES = new Set(['reserved', 'failed', 'abandoned']);

const toolByName = new Map(ORCHESTRATION_TOOLS.map((tool) => [tool.name, tool]));

/**
 * @param {object} deps daemon operations; see session-daemon.js for the wiring.
 */
export function createOrchestrationService(deps) {
  const {
    registry,
    activateSession,
    // Moves a session's leaf to a tree entry: (sessionId, entryId) => navigation.
    navigateSession,
    getLiveRuntime,
    listLiveRuntimes,
    getSessionState,
    createWorkerSession,
    sendInput,
    abortSession,
    // Aborts the run that `run` (a handle the daemon bound to it) names, and
    // nothing else; returns whether it did.
    abortRun = () => false,
    readSettings,
    listModels,
    hostStatus,
    resolveBranch = async () => undefined,
    // `owner/repo` of a directory's origin, for a reported pull request.
    resolveRepository = async () => undefined,
    // Branch and worktree of a `worker_start` (see worker-start.js).
    prepareWorktree = prepareWorkerTree,
    // Uncached merge reads for `worker_cleanup` (lib/github/merge-lookup.js).
    pullLookup,
    // The daemon's session deletion, the last cleanup step.
    deleteSession,
    getSessionActivity = () => ({}),
    // Pending blocking dialogs of resident sessions: [{ sessionId, dialog }].
    listPendingDialogs = () => [],
    holdSession = () => () => {},
    // 'present' | 'absent' | 'unknown' for the worker's JSONL.
    sessionFileState = async () => 'unknown',
    // A live session created for this start operation, if any.
    findSessionByOperation = async () => undefined,
    now = () => Date.now(),
    // Canonical form of a worker directory, so spellings share one lock.
    canonicalDirectory = async (directory) => directory,
    // An admitted input whose outcome could not be recorded keeps its slot;
    // the daemon reports it to the session.
    onAdmissionUnresolved = () => {},
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
  // The run an admitted input of this service started, per worker, until it
  // settles: its admission and the generation its commit recorded.
  const liveRuns = new Map();
  // The order in which Pi started runs of this service (`seq` of a start).
  let startSeq = 0;
  // The `seq` of the latest start per worker.
  const latestStart = new Map();
  // Who wrote the last accepted input of a worker, 'owner' (the UI) or
  // 'orchestrator' (a session_send): the last writer decides whether the
  // orchestrator hears the end of the run (#156). Memory only; a worker
  // without an entry (daemon restart) wakes as before.
  const lastWriter = new Map();
  // Inputs per worker whose end this service cannot prove yet (a stop could
  // not settle them, or their run started without a slot), and the registry
  // hold that keeps the worker's slot and directory until each is settled.
  const staleInputs = new Map();
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
  const wakes = createWakes({
    registry,
    getLiveRuntime,
    activateSession,
    holdSession,
    stateOf,
    runStartedAt: (sessionId) => getSessionActivity(sessionId)?.runStartedAt,
    waitingForInput: (sessionId) => Boolean(getSessionActivity(sessionId)?.waitingForInput),
    readSettings,
    now,
    isGone,
  });
  const prWatch = createPrWatch({ registry, emit: wakes.emit, readSettings });
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
        if (GONE_CODES.has(error?.code) || UNREADABLE_CODES.has(error?.code)) {
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
      profile: profileView(worker.profile),
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
      profiles: TOOL_PROFILES,
      roleProfiles: ROLE_PROFILES,
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
                ...(intent.profile ? { profile: intent.profile } : {}),
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
    const profile = resolveProfile(args);
    const title = args.title?.trim() || args.task.trim().split(/\r?\n/)[0].slice(0, 80);
    const intent = {
      cwd,
      title,
      brief: `${workerPreamble(callerSessionId)}${args.task}`,
      ...(args.role ? { role: args.role } : {}),
      profile,
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      ...(args.issue ? { issue: args.issue } : {}),
      ...(args.branch ? { branch: args.branch } : {}),
      ...(args.servesPr ? { servesPr: args.servesPr } : {}),
    };
    const reserved = await registry.update((document) => {
      ensureOwner(document, callerSessionId, runtime.cwd);
      return reserveSpawn(document, {
        caller: callerSessionId,
        clientRequestId: args.clientRequestId,
        intent,
        workerLimit: settings.workerLimit,
        ...(settings.gate.enabled ? { hostGate: { ...hostGateNumbers(hostStatus()), minAvailableBytes: settings.gate.minAvailableBytes } } : {}),
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
      profile: profileView(worker?.profile).name,
      ...(worker?.model ? { model: worker.model } : {}),
      ...(outcome.deduplicated ? { deduplicated: true } : {}),
    };
    if (args.mode === 'wait') {
      const waited = await wait(callerSessionId, { sessionIds: [sessionId], timeoutMs: args.timeoutMs }, options);
      return { ...result, ...waited.sessions[0], timedOut: waited.timedOut };
    }
    return { ...result, state: stateOf(sessionId) };
  };

  // `worker_start`: branch and worktree, then the spawn path under the same
  // clientRequestId, so a repeated call reuses all three.
  const startWorker = async (callerSessionId, args, options, context) => {
    const { worktreeRoot } = await readSettings();
    const { branch, worktree } = await prepareWorktree({ cwd: context.runtime.cwd, branchName: args.branchName, worktreeRoot });
    const spawned = await spawn(callerSessionId, {
      clientRequestId: args.clientRequestId,
      cwd: worktree,
      task: args.brief,
      title: `${args.issue.repo}#${args.issue.number} ${args.branchName}`,
      role: args.role,
      ...(args.model ? { model: args.model } : {}),
      ...(args.thinking ? { thinking: args.thinking } : {}),
      ...(args.profile ? { profile: args.profile } : {}),
      ...(args.excludeExtensions ? { excludeExtensions: args.excludeExtensions } : {}),
      issue: { repo: args.issue.repo, number: args.issue.number },
      branch,
    }, options, context);
    return {
      sessionId: spawned.sessionId,
      branch,
      worktree: spawned.cwd ?? worktree,
      ...(spawned.deduplicated ? { deduplicated: true } : {}),
    };
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
    // Entries of the active branch, so a message carries the id a rewind takes.
    const sessionManager = runtime.session.sessionManager;
    const messages = (sessionManager?.getBranch?.() ?? sessionManager?.getEntries?.() ?? [])
      .map((entry) => (entry?.type === 'message'
        ? { entryId: entry.id, role: entry.message?.role, text: textOf(entry.message?.content) || (entry.message?.role === 'toolResult' ? '(no text)' : '') }
        : entry?.type === 'custom_message'
          ? { entryId: entry.id, role: 'custom', customType: entry.customType, text: textOf(entry.content) }
          : undefined))
      .filter((message) => message && (message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult' || message.role === 'custom'))
      .slice(-limit)
      .map((message) => ({ ...message, text: truncate(message.text, READ_TEXT_LIMIT) }))
      .filter((message) => message.text.length > 0);
    const lineage = lineageOf(runtime);
    return {
      ...snapshot(args.sessionId, runtime),
      cwd: runtime.cwd,
      title: runtime.session.sessionManager?.getSessionName?.(),
      ...(lineage ? { parentSessionId: lineage.parentSessionId, profile: profileView(recordedProfile(lineage)) } : {}),
      messages,
    };
  };

  const send = (callerSessionId, args) => withSession(args.sessionId, () => sendSession(callerSessionId, args));

  const sendSession = async (callerSessionId, args) => {
    const runtime = getLiveRuntime(args.sessionId) ?? await activateSession(args.sessionId);
    const receipt = await startTask(runtime.session.sessionId, args.text, args.delivery ?? 'prompt', args.clientRequestId);
    // An accepted message from the worker's owner answers its open question.
    const resolved = args.resolves === undefined ? undefined : await registry.update((document) => (
      document.workers[args.sessionId]?.orchestratorSessionId === callerSessionId
      && closeQuestion(document, args.sessionId, args.resolves)
    ));
    return {
      sessionId: args.sessionId,
      accepted: true,
      ...(receipt?.deduplicated ? { deduplicated: true } : {}),
      ...(resolved !== undefined ? { resolved } : {}),
      state: stateOf(args.sessionId),
    };
  };

  /**
   * The owner answers a worker's open question from the control center
   * (#20): the text goes to the worker as the owner's own prompt, and the
   * question closes only after Pi accepted it. A question that is not open
   * changes nothing and sends nothing; a refused prompt leaves it open.
   */
  const answer = ({ sessionId, questionId, text, clientRequestId }) => withSession(sessionId, async () => {
    if ((await registry.read()).workers[sessionId]?.question?.id !== questionId) {
      throw new OrchestrationError('ORCHESTRATION_QUESTION_UNKNOWN', 'This question is not open.', { sessionId, questionId });
    }
    const receipt = await sendInput({ sessionId, text, delivery: 'prompt', operationId: clientRequestId, source: 'owner' });
    // A report meanwhile may have closed or replaced it; then only the prompt counts.
    const resolved = await registry.update((document) => closeQuestion(document, sessionId, questionId));
    return { sessionId, questionId, accepted: true, resolved, ...(receipt?.deduplicated ? { deduplicated: true } : {}) };
  });

  // The owner marks a question answered without prompting the worker (#20),
  // for an answer given in the worker's chat, which does not close it.
  const resolve = ({ sessionId, questionId }) => withSession(sessionId, async () => {
    if (!(await registry.update((document) => closeQuestion(document, sessionId, questionId)))) {
      throw new OrchestrationError('ORCHESTRATION_QUESTION_UNKNOWN', 'This question is not open.', { sessionId, questionId });
    }
    return { sessionId, questionId, resolved: true };
  });

  // Moves an idle worker of the caller back to an earlier entry and, with a
  // prompt, runs it again from there. A run, a retry, a start and an open
  // dialog all refuse: navigating under them would change a live transcript.
  const rewindOnce = (args) => withSession(args.sessionId, async () => {
    const activity = getSessionActivity(args.sessionId);
    if (!isSettled(args.sessionId) || activity?.waitingForInput || activity?.inputActive) {
      throw new OrchestrationError('ORCHESTRATION_SESSION_BUSY', 'The worker is running or waiting for input; interrupt it or wait until it is idle.', { sessionId: args.sessionId });
    }
    let navigation;
    try {
      navigation = await navigateSession(args.sessionId, args.entryId);
    } catch (error) {
      if (error?.code === 'SESSION_TREE_NOT_FOUND' || /^Entry .* not found$/.test(error?.message ?? '')) {
        throw new OrchestrationError('SESSION_TREE_NOT_FOUND', `The session has no entry ${args.entryId}; read it with session_read.`, { sessionId: args.sessionId });
      }
      throw error;
    }
    if (args.prompt !== undefined) await startTask(args.sessionId, args.prompt, 'prompt', args.clientRequestId);
    return {
      sessionId: args.sessionId,
      previousLeafId: navigation.previousLeafId,
      newLeafId: navigation.newLeafId,
      prompted: args.prompt !== undefined,
    };
  });

  // A repeated clientRequestId replays the first answer instead of moving the
  // leaf again, which would hide the run the first call started. The memory
  // is per process, like the send receipts it sits in front of.
  const rewinds = new Map();
  const REWIND_MEMORY = 256;
  const rewind = (_callerSessionId, args) => {
    if (!args.clientRequestId) return rewindOnce(args);
    const key = `${args.sessionId}\u0000${args.clientRequestId}`;
    const seen = rewinds.get(key);
    if (seen) {
      if (seen.args.entryId !== args.entryId || seen.args.prompt !== args.prompt) {
        throw new OrchestrationError('OPERATION_PAYLOAD_MISMATCH', 'This clientRequestId was already used for a different rewind.', { sessionId: args.sessionId });
      }
      return seen.result.then((result) => ({ ...result, deduplicated: true }));
    }
    const result = rewindOnce(args);
    rewinds.set(key, { args, result });
    result.catch(() => rewinds.delete(key));
    if (rewinds.size > REWIND_MEMORY) rewinds.delete(rewinds.keys().next().value);
    return result;
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
    for (const id of outcome.held) if (!result.held.includes(id)) result.held.push(id);
    result.failed.push(...outcome.failed);
    return outcome.ok;
  };

  const stopOne = async (sessionId, owner) => {
    const result = { stopped: [], failed: [], held: [] };
    let unsettled;
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
      // Inputs still unresolved now belong to this stop: their late verdict
      // aborts the run instead of confirming an admission. Pi accepted them,
      // so until each is settled the worker keeps a hold on its slot.
      unsettled = invalidateTickets(sessionId, claim.token);
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
      if (!worker) return { held: false };
      if (!holdsClaim(worker)) return false;
      delete worker.stopping;
      delete worker.doneReported;
      delete worker.admission;
      // The stop ends the conversation: nobody answers its question any more (#231).
      delete worker.question;
      worker.state = 'stopped';
      worker.stateSince = now();
      // Checked in this write: a verdict that settles an input later queues
      // its release behind it.
      if ((unsettled?.pending.size ?? 0) === 0) return { held: false };
      setHold(document, sessionId, { token: unsettled.token, process: self, at: now(), reason: 'unresolved_input' });
      return { held: true };
    });
    if (!marked) {
      result.failed.push({ sessionId, code: 'ORCHESTRATION_STOP_CLAIM_LOST' });
      return { ok: false, ...result };
    }
    // Stopped, but not free: the worker's slot and directory stay held until
    // Pi settled the inputs it had accepted.
    if (marked.held) result.held.push(sessionId);
    pendingRuns.delete(sessionId);
    deferredSettles.delete(sessionId);
    result.stopped.push(sessionId);
    return { ok: true, ...result };
  };

  const stop = async (callerSessionId, args) => {
    const worker = (await registry.read()).workers[args.sessionId];
    if (worker?.state === 'stopped') return { sessionId: args.sessionId, stopped: [], alreadyStopped: true };
    const result = { stopped: [], failed: [], held: [] };
    await stopTree(args.sessionId, callerSessionId, result);
    notifyWaiters();
    if (result.failed.length > 0) {
      throw new OrchestrationError('ORCHESTRATION_STOP_FAILED', 'Some workers could not be aborted and keep running; retry session_stop.', {
        sessionId: args.sessionId,
        ...result,
      });
    }
    // `held`: stopped workers that keep their slot and directory until Pi
    // settled an input it had accepted before the stop.
    return { sessionId: args.sessionId, stopped: result.stopped, ...(result.held.length > 0 ? { held: result.held } : {}) };
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

  /**
   * A worker's report. A `done` binds to the run that makes it (frozen
   * before any await): the worker becomes `done` and frees its slot when that
   * run ends (`applySettle`), not now, since the run may still call tools.
   */
  const report = async (callerSessionId, args, _options, { runtime }) => {
    const violation = reportViolation(args);
    if (violation) throw new OrchestrationError('INVALID_ARGUMENT', violation);
    const run = args.kind === 'done' ? liveRuns.get(callerSessionId) : undefined;
    const repository = args.pullRequest === undefined
      ? null
      : (await resolveRepository(runtime.cwd).catch(() => undefined)) ?? null;
    const { value, generation } = await withDoneReport(callerSessionId, run, (document) => recordReport(document, callerSessionId, args, {
      at: now(), questionId: `q-${randomUUID().slice(0, 8)}`, repository,
    }));
    wakes.touch(callerSessionId);
    if (!value.deduplicated) {
      // A report for the owner is not the orchestrator's business (#156).
      if ((args.kind === 'question' || args.kind === 'blocked') && args.audience !== 'owner') {
        wakes.emit(callerSessionId, args.kind === 'blocked' ? 'blocked' : 'question', args.summary);
      } else if (args.kind === 'ready') {
        wakes.emit(callerSessionId, 'ready', args.summary);
      }
    }
    return {
      sessionId: callerSessionId,
      kind: args.kind,
      ...(value.deduplicated ? { deduplicated: true } : {}),
      ...(value.question ? { openQuestion: value.question.id } : {}),
      ...(args.kind === 'done' && !value.deduplicated ? { doneAtRunEnd: generation !== null } : {}),
    };
  };

  // Live state from the live channels only; a session without a resident
  // runtime is `dormant` and is not opened.
  const liveOf = (sessionId, runtime) => {
    if (!runtime) return { live: 'dormant', liveSince: null };
    const state = stateOf(sessionId);
    if (state === 'dormant') return { live: state, liveSince: null };
    // A dialog can wait before any run starts (an input hook or extension
    // command asking the owner) while the runtime still reports idle.
    const { runStartedAt, retry, waitingForInput } = getSessionActivity(sessionId) ?? {};
    const liveSince = Number.isFinite(runStartedAt) ? runStartedAt : null;
    if (waitingForInput) return { live: 'waiting_input', liveSince };
    if (state === 'idle') return { live: state, liveSince: null };
    if (retry || state === 'retry') return { live: 'retry', liveSince };
    if (state === 'busy' || state === 'starting') return { live: 'busy', liveSince };
    return { live: null, liveSince: null };
  };

  // The first pending blocking dialog of a session, in short.
  const dialogOf = (sessionId) => {
    const pending = listPendingDialogs().find((entry) => entry.sessionId === sessionId)?.dialog;
    return pending ? { requestId: pending.requestId, method: pending.method, title: pending.title ?? null } : null;
  };

  const digestWorker = async (sessionId, worker) => {
    const runtime = getLiveRuntime(sessionId);
    const settled = worker.snapshot;
    const { requestId: _requestId, ...report } = worker.report ?? {};
    return {
      sessionId,
      title: worker.title ?? null,
      role: worker.role ?? null,
      profile: profileView(worker.profile),
      issue: worker.issue ?? null,
      branch: (await resolveBranch(worker.cwd).catch(() => undefined)) ?? worker.branch ?? null,
      worktree: worker.cwd ?? null,
      pullRequest: worker.pullRequest ?? null,
      lifecycle: worker.state,
      lifecycleSince: worker.stateSince ?? null,
      ...liveOf(sessionId, runtime),
      lastProgressAt: (runtime ? lastTimestamp(runtime) : undefined) ?? settled?.lastProgressAt ?? null,
      lastInputAt: worker.lastInputAt ?? null,
      report: worker.report ? report : null,
      question: worker.question ?? null,
      dialog: dialogOf(sessionId),
      lastError: settled?.lastError ?? null,
      usage: settled?.usage ? { settled: settled.usage, settledAt: settled.at } : null,
    };
  };

  /** All workers of the caller from the registry and the live channels; activates nothing. */
  const digest = async (callerSessionId, args) => {
    const [document, { workerLimit }] = await Promise.all([registry.read(), readSettings()]);
    const wanted = args.sessionIds ? new Set(args.sessionIds) : undefined;
    const operations = Object.entries(document.operations)
      .filter(([, operation]) => operation.orchestratorSessionId === callerSessionId
        && DIGEST_OPERATION_STATES.has(operation.state))
      .map(([opId, operation]) => ({
        opId,
        kind: operation.kind,
        state: operation.state,
        step: operation.step,
        error: operation.error ?? null,
        since: operation.stateSince ?? null,
      }));
    const workers = await Promise.all(workersOf(document, callerSessionId)
      .filter(([sessionId]) => !wanted || wanted.has(sessionId))
      .map(([sessionId, worker]) => digestWorker(sessionId, worker)));
    return { at: now(), ...capacity(document, workerLimit), operations, workers };
  };

  const capacity = (document, workerLimit) => {
    const used = slotsInUse(document);
    return { limit: { workerLimit, used }, host: { ...hostGateNumbers(hostStatus()), workers: used, limit: workerLimit } };
  };

  /**
   * The owner's view (#20): every orchestrator, marked or still owning
   * workers, with its workers, the slot use, the host and the pending
   * dialogs of resident sessions. Reads the registry and the live channels
   * only and activates nothing; a failed registry or settings read rejects.
   */
  const overview = async () => {
    const [document, { workerLimit, orchestrators: marked = [] }] = await Promise.all([registry.read(), readSettings()]);
    const owners = new Set(marked);
    for (const worker of Object.values(document.workers)) {
      if (worker.state !== 'removed' && worker.orchestratorSessionId) owners.add(worker.orchestratorSessionId);
    }
    const titleOf = (runtime) => runtime?.session?.sessionManager?.getSessionName?.() ?? null;
    const orchestrators = await Promise.all([...owners].map(async (sessionId) => ({
      sessionId,
      marked: marked.includes(sessionId),
      title: titleOf(getLiveRuntime(sessionId)),
      workers: await Promise.all(workersOf(document, sessionId).map(async ([workerId, worker]) => ({
        ...await digestWorker(workerId, worker),
        pullRequestStatus: prWatch.statusOf(workerId, worker.pullRequest),
      }))),
    })));
    const dialogs = listPendingDialogs().map(({ sessionId, dialog }) => {
      const runtime = getLiveRuntime(sessionId);
      return {
        sessionId,
        title: titleOf(runtime),
        directory: runtime?.cwd ?? null,
        orchestratorSessionId: document.workers[sessionId]?.orchestratorSessionId ?? null,
        dialog,
      };
    });
    return { at: now(), ...capacity(document, workerLimit), orchestrators, dialogs };
  };

  // Removes a worker after the proven merge of its pull request (#118):
  // worktree, local and remote branch, then the session, then the record.
  // A refusal removes nothing and returns the reason. The target is stored
  // before the first step, so a repeated call finds it after the worktree is
  // gone. A helper bound by `servesPr` has no tree; only its session goes.
  // The call holds the worker's `stopping` claim throughout, so no new input
  // is admitted, and the session's idle guard, so it stays resident here.
  const cleanupWorker = async (_callerSessionId, { sessionId }) => {
    const claim = { ...self, token: randomUUID() };
    const claimed = await registry.update((document) => {
      const worker = document.workers[sessionId];
      if (!worker || worker.stopping) return false;
      worker.stopping = claim;
      return true;
    });
    if (!claimed) return { sessionId, removed: [], reason: 'The worker is being stopped or cleaned up; retry once that has finished.' };
    try {
      return await withSession(sessionId, () => cleanupClaimed(sessionId, claim));
    } finally {
      await registry.update((document) => {
        const worker = document.workers[sessionId];
        if (worker?.stopping?.token === claim.token) delete worker.stopping;
      });
    }
  };

  // Why the worker may not lose its work now, or null. As for takeover, only a
  // session proven idle here counts: one resident in another daemon or that
  // cannot be checked is not idle; a deleted one has no run left.
  const cleanupBusy = async (sessionId, claim) => {
    let runtime = getLiveRuntime(sessionId);
    if (!runtime) {
      try {
        runtime = await activateSession(sessionId);
      } catch (error) {
        if (!isGone(error)) return 'The worker cannot be checked here, it may still run in another PiChamber instance.';
      }
    }
    const worker = (await registry.read()).workers[sessionId];
    if (worker?.stopping?.token !== claim.token) return 'The worker was stopped meanwhile.';
    // A stop leaves a hold for an input or run it could not settle; Pi may
    // still start it, so the hold counts as busy until it is released.
    if (worker.hold) return `The worker still holds an unsettled input or run from a stop (${worker.hold.reason}); retry once it is released.`;
    const activity = getSessionActivity(sessionId) ?? {};
    if ((runtime && !isSettled(sessionId)) || activity.waitingForInput || activity.inputActive || worker.admission || ticketsOf(sessionId).length > 0) {
      return 'The worker is running or waiting for input; stop it or wait until it is idle.';
    }
    return null;
  };

  const cleanupClaimed = async (sessionId, claim) => {
    const refused = (reason) => ({ sessionId, removed: [], reason });
    const busy = await cleanupBusy(sessionId, claim);
    if (busy) return refused(busy);
    const worker = (await registry.read()).workers[sessionId];
    const lookup = async (read) => {
      if (!pullLookup) return { lookupError: 'GitHub is not available in this daemon.' };
      try {
        return { pr: await read() };
      } catch (error) {
        return { lookupError: error?.message ?? String(error) };
      }
    };
    let removed = [];
    if (worker.servesPr && !worker.cleanup) {
      const { repo: repository, number } = worker.servesPr;
      const reason = cleanupRefusal({ helper: true, ...(await lookup(() => pullLookup.pullByNumber({ repository, number }))) });
      if (reason) return refused(reason);
      // Checked again after the GitHub read.
      const busyNow = await cleanupBusy(sessionId, claim);
      if (busyNow) return refused(busyNow);
    } else {
      let target = worker.cleanup;
      if (!target) {
        try {
          target = await resolveCleanupTarget(worker.cwd);
        } catch (error) {
          return refused(`${error.message} Without a servesPr binding it stays for the owner.`);
        }
      }
      if (!target.branch) return refused(cleanupRefusal({}));
      const { pr, lookupError } = target.repository
        ? await lookup(() => pullLookup.pullForBranch({ repository: target.repository, branch: target.branch }))
        : { lookupError: 'The worktree has no github.com origin.' };
      // The run and the tree are read after the GitHub read, right before the
      // first git step.
      const busyNow = await cleanupBusy(sessionId, claim);
      if (busyNow) return refused(busyNow);
      const tree = await readTreeState(target);
      const reason = cleanupRefusal({ branch: target.branch, pr, lookupError, ...tree });
      if (reason) return refused(reason);
      if (!worker.cleanup) {
        await registry.update((document) => {
          if (document.workers[sessionId]) document.workers[sessionId].cleanup = target;
        });
      }
      removed = await removeWorkerTree(target, tree, pr.headSha);
    }
    try {
      await deleteSession(sessionId);
      removed.push(`session ${sessionId}`);
    } catch (error) {
      if (!isGone(error)) {
        throw new OrchestrationError('WORKER_CLEANUP_FAILED', `Cleanup failed at step session: ${error?.message ?? String(error)}. Call worker_cleanup again.`, { step: 'session', removed });
      }
    }
    await registry.update((document) => {
      delete document.workers[sessionId];
    });
    return { sessionId, removed };
  };

  const handlers = {
    orchestration_capabilities: capabilities,
    orchestration_digest: digest,
    worker_report: report,
    session_spawn: spawn,
    worker_start: startWorker,
    session_list: list,
    session_read: read,
    session_send: send,
    session_wait: wait,
    session_interrupt: interrupt,
    session_stop: stop,
    session_rewind: rewind,
    worker_cleanup: cleanupWorker,
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
    const callerKind = await kindOf(callerSessionId, runtime);
    if (callerKind === 'orchestrator') await ensureImported(callerSessionId, runtime);
    const targetOwner = needsOwnership(toolName)
      ? (await registry.read()).workers[args?.sessionId]?.orchestratorSessionId ?? null
      : undefined;
    authorize({ toolName, callerSessionId, callerKind, targetOwner });
    return handlers[toolName](callerSessionId, args ?? {}, options, { runtime, callerKind });
  };

  // A worker stays a worker even when marked; any other session orchestrates
  // only while settings.json marks it (read fresh, so a mark acts at once).
  const kindOf = async (sessionId, runtime) => {
    if (lineageOf(runtime)) return 'worker';
    const { orchestrators = [] } = await readSettings();
    return orchestrators.includes(sessionId) ? 'orchestrator' : 'unmarked';
  };

  /**
   * Confirms that a session exists and tells its kind, read fresh: before a
   * credential is issued for it, and on every MCP tool discovery.
   */
  const verifyCaller = async (callerSessionId) => {
    const runtime = await callerRuntime(callerSessionId);
    return { sessionId: callerSessionId, kind: await kindOf(callerSessionId, runtime) };
  };

  /**
   * Called by the daemon when a send finished without an agent turn (a
   * handled extension command), so no agent_settled follows.
   */
  const onInputCompleted = (sessionId) => {
    if (!pendingRuns.delete(sessionId)) return;
    notifyWaiters();
  };

  const captureResult = (runtime) => ({ assistant: lastAssistant(runtime) });

  /**
   * Called by the daemon for every agent_settled. A run this service tracks
   * ends with its prompt (`finishRun`); any other settle applies the worker's
   * state transition, resolves waits and emits a worker's run end as a wake.
   * Every settle also hands a settled owner its queued wakes.
   * The `done` rule applies only to the generation that ended. While an
   * admitted input has no outcome yet it waits, because that input may start
   * the next run in the same slot (`resolveInput` applies or drops it).
   */
  const onSessionSettled = async (sessionId, runtime) => {
    pendingRuns.delete(sessionId);
    notifyWaiters();
    wakes.settled(sessionId);
    // Taken before any await: a later turn must not replace it.
    const result = captureResult(runtime);
    // A run of this service ends only with its own prompt (`finishRun`). The
    // event is no proof of that: Pi 1.1.0 can emit it for an earlier prompt
    // while this run waits in its retry backoff. It only records the result
    // of the run that started last.
    const run = liveRuns.get(sessionId);
    if (run) {
      if (latestStart.get(sessionId) === run.seq) run.result = result;
      return;
    }
    await applyRunEnd(sessionId, runtime, undefined, result);
  };

  // The prompt that started `run` ended: the proven end of exactly this run.
  const finishRun = async (sessionId, run) => {
    if (liveRuns.get(sessionId) === run) liveRuns.delete(sessionId);
    const runtime = getLiveRuntime(sessionId);
    try {
      await applyRunEnd(sessionId, runtime, run, run.result ?? captureResult(runtime));
    } finally {
      notifyWaiters();
    }
  };

  // Applies a run's end: durability, the `done` rule of its generation (none
  // for a run of no tracked start), and the run end's wake.
  const applyRunEnd = async (sessionId, runtime, run, result) => {
    // A run whose start could not be recorded completes its commit at its
    // end (R7-S1).
    if (run) await run.committed;
    const lineage = runtime ? lineageOf(runtime) : undefined;
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
    const snapshot = runtime ? settleSnapshot(runtime, now()) : undefined;
    const outcome = outcomeOf(result.assistant);
    let settled;
    try {
      settled = await registry.update((current) => {
        const hold = (tickets.get(sessionId)?.size ?? 0) > 0;
        // The registry checks the start the run froze: only the run that holds
        // the current generation applies its `done`; no run of this service,
        // or a start a later one replaced, is foreign.
        let generation = null;
        let foreign = true;
        if (run) {
          const completed = completeStart(current, sessionId, now(), {
            admission: run.admission, start: run.start, seq: run.seq, keep: admissionInUse(sessionId, run.admission),
          });
          generation = completed.generation ?? null;
          foreign = completed.stale === true;
        }
        const wasDone = current.workers[sessionId]?.state === 'done';
        const state = applySettle(current, sessionId, presence, now(), { generation, hold: hold || foreign });
        // The text of the done news travels with a settle that waits for an input.
        if (hold && !foreign) deferredSettles.set(sessionId, { generation, news: outcome === 'interrupted' ? 'interrupted' : textOf(result.assistant?.content) });
        const worker = current.workers[sessionId];
        if (worker && snapshot) worker.snapshot = snapshot;
        return { state, becameDone: state === 'done' && !wasDone, worker: worker ? { ...worker } : undefined };
      });
    } catch (error) {
      // The worker keeps its slot; better held than freed under a run.
      if (run && run.generation === null) reportUnresolved(sessionId, error);
      throw error;
    }
    if (!settled.worker || settled.worker.stopping || settled.state === 'stopped') return;
    const { assistant } = result;
    // A worker that reported done is done news whoever started the run; any
    // other end of a run the owner started is the owner's business.
    if (settled.becameDone) wakes.emit(sessionId, 'done', outcome === 'interrupted' ? 'interrupted' : textOf(assistant?.content));
    else if (outcome === 'error') wakes.emit(sessionId, 'run_failed', assistant.errorMessage ?? 'the run failed');
    else if (lastWriter.get(sessionId) !== 'owner') wakes.emit(sessionId, 'run_finished', outcome === 'interrupted' ? 'interrupted' : textOf(assistant?.content));
  };

  /*
   * Input admission. The daemon's one input path calls `beforeSessionInput`
   * before it activates a session, `admitInput` once it holds the session's
   * lease right before the prompt, and `resolveInput` with Pi's verdict on
   * that prompt. Only the admission decides about a slot, and only Pi's
   * verdict ends it:
   * - `started`: the run takes the slot as a new generation (`completeStart`).
   * - `queued`, `handled`, `rejected`: no run; once no admitted input of the
   *   worker is left, a slot the admission took goes back and a settle that
   *   waited for the inputs applies.
   * - `unresolved`: Pi accepted the prompt without a verdict (a prompt
   *   deferred while the previous run settles). Nothing is rolled back: the
   *   slot stays and the registry shows `admission.state: 'unresolved'`
   *   until the late verdict (Pi runs the deferred prompt again) or a stop.
   * Every step names the ticket's admission, and the registry applies it
   * only while the worker still shows that admission. A stop deletes it and
   * makes the remaining tickets stale: their late `started` aborts the run
   * and confirms nothing. Neither a settle nor the end of a ticket ends a
   * started run's occupancy; only the end of the prompt that started it
   * does (`finished`), and without that proof it stays held.
   */
  const ticketsOf = (sessionId) => [...(tickets.get(sessionId)?.values() ?? [])];
  const openTicketsDone = async (sessionId) => {
    let open = ticketsOf(sessionId).filter((ticket) => ticket.state === 'open');
    while (open.length > 0) {
      await Promise.all(open.map((ticket) => ticket.decided));
      open = ticketsOf(sessionId).filter((ticket) => ticket.state === 'open');
    }
  };
  // Whether an input of this admission is still open; a ticket still being
  // admitted will share it.
  const admissionInUse = (sessionId, admission, except) => ticketsOf(sessionId)
    .some((ticket) => ticket !== except && (ticket.admission === undefined || ticket.admission === admission));
  const ownsAdmission = (process) => sameStamp(process, self);
  // A stop ends the admission; its remaining inputs can no longer confirm a run.
  // Returns the record that holds them, if any are left.
  const invalidateTickets = (sessionId, token) => {
    const left = ticketsOf(sessionId);
    for (const ticket of left) {
      ticket.state = 'stale';
      ticket.decide();
    }
    tickets.delete(sessionId);
    return left.length > 0 ? trackStale(sessionId, token, left) : undefined;
  };
  const trackStale = (sessionId, token, list) => {
    let record = staleInputs.get(sessionId);
    if (!record) {
      record = { token, pending: new Set() };
      staleInputs.set(sessionId, record);
    }
    for (const ticket of list) {
      ticket.hold = record;
      record.pending.add(ticket);
    }
    return record;
  };
  // A stale input is settled: its verdict started no run, or its run settled.
  // The last one releases the hold.
  const settleStale = async (ticket) => {
    const record = ticket.hold;
    if (!record?.pending.delete(ticket) || record.pending.size > 0) return;
    if (staleInputs.get(ticket.sessionId) === record) staleInputs.delete(ticket.sessionId);
    try {
      await registry.update((document) => releaseHold(document, ticket.sessionId, record.token));
    } catch (error) {
      reportUnresolved(ticket.sessionId, error);
    }
    notifyWaiters();
  };

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
  const admitInput = async (sessionId, source = 'owner') => {
    if (!await readForInput(sessionId)) return null;
    const { workerLimit } = await readSettings();
    const ticket = { sessionId, token: randomUUID(), state: 'open', source };
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
    ticket.admission = admitted.admission;
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
    const { sessionId, admission } = ticket;
    tickets.get(sessionId)?.delete(ticket.token);
    ticket.state = 'closed';
    ticket.decide();
    if ((tickets.get(sessionId)?.size ?? 0) > 0) return;
    tickets.delete(sessionId);
    const deferredSettle = deferredSettles.get(sessionId);
    deferredSettles.delete(sessionId);
    // A started run whose start is not recorded keeps the admission's slot
    // until it settles.
    const run = liveRuns.get(sessionId);
    const occupied = run !== undefined && run.admission === admission && run.generation === null;
    let becameDone = false;
    try {
      await registry.update((document) => {
        if (!occupied) releaseAdmission(document, sessionId, now(), admission);
        if (deferredSettle) {
          const wasDone = document.workers[sessionId]?.state === 'done';
          const state = applySettle(document, sessionId, undefined, now(), { generation: deferredSettle.generation });
          becameDone = state === 'done' && !wasDone && document.workers[sessionId]?.stopping !== true;
        }
      });
    } catch (error) {
      reportUnresolved(sessionId, error);
    }
    if (deferredSettle) notifyWaiters();
    // The done news the settle held back, once, whoever started the run.
    if (becameDone) wakes.emit(sessionId, 'done', deferredSettle.news);
  };

  // Whether a run's prompt proved its end (`finished` resolves true).
  const proof = (finished) => (finished
    ? Promise.resolve(finished).then((value) => value === true, () => false)
    : Promise.resolve(false));

  // An occupancy whose end has no proof keeps its slot and directory as an
  // `unproven_run` hold until reconcile finds this process dead, and is
  // reported. Neither a settle nor time ends it.
  const holdUnprovenRun = async (sessionId, token) => {
    try {
      await registry.update((document) => holdUnproven(document, sessionId, { token, process: self, at: now() }));
    } catch (error) {
      reportUnresolved(sessionId, error);
    }
    reportUnresolved(sessionId, new OrchestrationError(
      'ORCHESTRATION_RUN_UNPROVEN',
      'A run started whose end cannot be proven; it keeps a slot and its directory until this daemon process ends.',
      { sessionId },
    ));
  };

  /**
   * A stale input's verdict: its stop ended the admission, so a run it
   * started has no slot. The worker holds a slot and its directory for it
   * (`hold`); only its bound run is aborted, and only its own prompt's end
   * releases the hold. Without that proof the hold stays (`unproven_run`).
   */
  const staleStarted = async (ticket, signal, finished) => {
    const { sessionId } = ticket;
    const record = ticket.hold ?? trackStale(sessionId, ticket.token, [ticket]);
    try {
      await registry.update((document) => setHold(document, sessionId, {
        token: record.token, process: self, at: now(), reason: 'stale_run',
      }));
    } catch (error) {
      reportUnresolved(sessionId, error);
    }
    if (signal) await withSession(sessionId, () => abortRun(sessionId, signal)).catch(() => {});
    return {
      completion: proof(finished).then((proven) => (proven
        ? settleStale(ticket)
        : holdUnprovenRun(sessionId, record.token))),
    };
  };

  // A started verdict whose prompt started no run of its own: the input
  // keeps its admission until that prompt ended.
  const endWithPrompt = async (ticket, finished) => {
    const proven = await proof(finished);
    if (ticket.state === 'stale') {
      ticket.state = 'closed';
      if (proven) await settleStale(ticket);
      else await holdUnprovenRun(ticket.sessionId, ticket.hold.token);
      return;
    }
    if (proven) {
      await closeTicket(ticket);
      return;
    }
    try {
      await registry.update((document) => markUnresolved(document, ticket.sessionId, { admission: ticket.admission, at: now() }));
    } catch (error) {
      reportUnresolved(ticket.sessionId, error);
    }
    await holdUnprovenRun(ticket.sessionId, ticket.token);
  };

  /**
   * Pi's verdict on an admitted input: `started`, `queued` or `handled`
   * (preflight), `rejected`, or `unresolved` (accepted without a verdict).
   * A `started` verdict carries the run's bound signal (`run`) and, when the
   * daemon can prove it, `finished`: resolves true once the prompt that
   * started exactly this run ended. A late verdict of a deferred prompt has
   * no such proof. Returns `{ completion }` for a started verdict, settled
   * once its end is applied.
   */
  const resolveInput = async (ticket, outcome, { run: handle, finished } = {}) => {
    if (!ticket || ticket.state === 'closed') return undefined;
    const { sessionId, admission } = ticket;
    if (outcome === 'started' || outcome === 'queued' || outcome === 'unresolved') lastWriter.set(sessionId, ticket.source);
    if (ticket.state === 'stale') {
      // A stop ended this input's admission: a run it starts has no slot.
      if (outcome === 'unresolved') return undefined;
      ticket.state = 'closed';
      if (outcome !== 'started') {
        await settleStale(ticket);
        return undefined;
      }
      const signal = await Promise.resolve(handle).catch(() => null);
      return staleStarted(ticket, signal, finished);
    }
    if (outcome === 'unresolved') {
      if (ticket.state !== 'open') return undefined;
      ticket.state = 'unresolved';
      ticket.decide();
      try {
        await registry.update((document) => markUnresolved(document, sessionId, { admission, at: now() }));
      } catch (error) {
        reportUnresolved(sessionId, error);
      }
      return undefined;
    }
    if (outcome !== 'started') {
      await closeTicket(ticket);
      return undefined;
    }
    // Verdict order, taken before any await.
    const seq = ++startSeq;
    latestStart.set(sessionId, seq);
    // Pi orders runs, not verdicts: only the ticket's own bound signal shows
    // that it started a run. Until then the ticket stays open with its slot.
    const signal = await Promise.resolve(handle).catch(() => null);
    if (ticket.state === 'stale') {
      // A stop ended an unresolved input while its run was being bound.
      ticket.state = 'closed';
      return staleStarted(ticket, signal, finished);
    }
    if (!signal) {
      ticket.state = 'unresolved';
      ticket.decide();
      return { completion: endWithPrompt(ticket, finished) };
    }
    // From here the run holds the admission's slot until its own end,
    // whatever happens to the other tickets.
    tickets.get(sessionId)?.delete(ticket.token);
    if ((tickets.get(sessionId)?.size ?? 0) === 0) tickets.delete(sessionId);
    ticket.state = 'closed';
    // The waiting settle belonged to the previous run; this run keeps the slot.
    deferredSettles.delete(sessionId);
    const run = { admission, start: ticket.token, seq, generation: null, signal };
    let settleRun;
    run.committed = new Promise((resolve) => { settleRun = resolve; });
    liveRuns.set(sessionId, run);
    let committed;
    try {
      committed = await registry.update((document) => completeStart(document, sessionId, now(), {
        admission, start: run.start, seq: run.seq, keep: admissionInUse(sessionId, admission),
      }));
    } catch (error) {
      // No rollback: the admission keeps the slot, and the run's next
      // registry step (done report, its end) retries the commit.
      reportUnresolved(sessionId, error);
    }
    run.generation = committed?.generation ?? null;
    settleRun(run.generation);
    ticket.decide();
    if (committed?.stale) {
      // A stop or a later start took the slot meanwhile: this run has none.
      if (liveRuns.get(sessionId) === run) liveRuns.delete(sessionId);
      return staleStarted(ticket, signal, finished);
    }
    return {
      completion: proof(finished).then(async (proven) => {
        if (proven) {
          await finishRun(sessionId, run);
          return;
        }
        if (liveRuns.get(sessionId) === run) liveRuns.delete(sessionId);
        await holdUnprovenRun(sessionId, run.start);
      }),
    };
  };

  /**
   * A worker reported `done` in its current run. The worker becomes `done`,
   * and its slot free, when that run settles; the run may still call tools.
   */
  const recordDoneReport = async (sessionId) => {
    // A run whose start could not be recorded completes its commit first, so
    // the report binds to its own generation (R7-S1). If that fails again,
    // the report fails and the slot stays.
    // The reporting run is frozen before any await, and the report binds to
    // its start, never to whatever generation is current. Without a live run
    // of this service there is no proof, and nothing is recorded.
    const run = liveRuns.get(sessionId);
    if (!run) return false;
    return (await withDoneReport(sessionId, run, () => undefined)).generation !== null;
  };

  // `change` and the binding of `run`'s done rule share one transaction; a
  // deduplicated change binds nothing.
  const withDoneReport = async (sessionId, run, change) => {
    if (run) await run.committed;
    const outcome = await registry.update((document) => {
      const value = change(document);
      if (!run || value?.deduplicated) return { value, generation: null };
      return { value, generation: bindDone(document, sessionId, run) };
    });
    if (outcome.generation !== null && run.generation === null) run.generation = outcome.generation;
    return outcome;
  };

  const bindDone = (document, sessionId, run) => {
    const worker = document.workers[sessionId];
    if (!worker || (worker.state !== 'active' && worker.state !== 'starting')) return null;
    const completed = completeStart(document, sessionId, now(), {
      admission: run.admission, start: run.start, seq: run.seq, keep: admissionInUse(sessionId, run.admission),
    });
    if (completed.stale || !holdsStart(worker, run.start)) return null;
    worker.doneReported = completed.generation;
    return completed.generation;
  };

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
        if (live.admission && !belongsToLiveProcess(live.admission.process)) releaseAdmission(current, sessionId, now(), live.admission.token);
        // A stop whose process died may not have aborted the run: the worker
        // keeps its state and slot, and session_stop can be retried.
        if (live.stopping && !belongsToLiveProcess(live.stopping)) delete live.stopping;
        // A hold ends with its process: that process's runs and inputs died with it.
        if (live.hold && !belongsToLiveProcess(live.hold.process)) delete live.hold;
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
    // Message and tool events of a session: progress for the stall watchdog.
    onSessionActivity: wakes.touch,
    // An extension dialog opened in a session; in a worker it is a question.
    onDialogOpened: (sessionId, title) => wakes.emit(sessionId, 'question', `dialog: ${title ?? 'input requested'}`),
    prWatch,
    overview,
    answer,
    resolve,
    startWakes: wakes.start,
    stopWakes: wakes.stop,
    verifyCaller,
    // 'worker' | 'orchestrator' | 'unmarked'; decides tools and instructions.
    sessionKind: (sessionManager) => kindOf(sessionManager.getSessionId(), { session: { sessionManager } }),
    // The recorded profile of a session (see `recordedProfile`); read on
    // every tool call and runtime build, so a restart keeps it.
    sessionProfile: (sessionManager) => recordedProfile(lineageOf({ session: { sessionManager } })),
    toolNames: ORCHESTRATION_TOOL_NAMES,
  };
}
