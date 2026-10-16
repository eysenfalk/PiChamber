import { resolve } from 'node:path';

import { OrchestrationError } from './errors.js';

// The registry document's rules: slot accounting, the start journal, worker
// state transitions, the input gate and takeover. Every function changes the
// document passed in by `registry-store.update`, so each runs inside one
// serialised transaction; none has a side effect outside the document.

const SLOT_WORKER_STATES = new Set(['starting', 'active']);
const RESTARTABLE_STATES = new Set(['done', 'stopped']);
const OPEN_OPERATION_STATES = new Set(['reserved']);

export const requestKey = (orchestratorSessionId, clientRequestId) => `${orchestratorSessionId}:${clientRequestId}`;

/**
 * A worker takes a slot and its directory while it is `starting` or
 * `active`, and in any state while it shows a `hold`: an occupancy whose end
 * could not be proven (an input a stop could not settle). Uncertainty counts
 * as use.
 */
const occupies = (worker) => SLOT_WORKER_STATES.has(worker.state) || Boolean(worker.hold);

/** Reserved operations plus occupying workers, across the daemon. */
export const slotsInUse = (document) => (
  Object.values(document.operations).filter((operation) => operation.state === 'reserved').length
  + Object.values(document.workers).filter(occupies).length
);

const assertFreeSlot = (document, workerLimit) => {
  const inUse = slotsInUse(document);
  if (inUse >= workerLimit) {
    throw new OrchestrationError('ORCHESTRATION_LIMIT', `All ${workerLimit} worker slots are in use; wait for a worker to finish or stop one.`, {
      workerLimit,
      inUse,
    });
  }
};

const GIB = 1024 ** 3;
const gib = (bytes) => (bytes / GIB).toFixed(1);

/**
 * Refuses a new start while the host is busy. `hostGate` is the host numbers
 * plus the settings' `minAvailableBytes`; without it the gate is off.
 */
const assertHostIdle = (hostGate) => {
  if (!hostGate) return;
  const { load1, cores, availableBytes, minAvailableBytes } = hostGate;
  if (load1 <= cores && availableBytes >= minAvailableBytes) return;
  throw new OrchestrationError('ORCHESTRATION_HOST_BUSY', `The host is busy: load ${load1.toFixed(2)} on ${cores} cores, ${gib(availableBytes)} GiB available (minimum ${gib(minAvailableBytes)} GiB). Wait for a worker to finish and try again.`, {
    load1,
    cores,
    availableBytes,
    minAvailableBytes,
  });
};

const sameDirectory = (left, right) => typeof left === 'string' && typeof right === 'string'
  && resolve(left) === resolve(right);

/**
 * One worker per worktree: a reserved start or a `starting`/`active` worker
 * holds its directory exactly as long as its slot, across all daemons of the
 * data root. Directories are canonical when written; `resolve` only folds
 * lexical spellings of older records.
 */
const assertFreeDirectory = (document, cwd, exceptSessionId) => {
  const operation = Object.entries(document.operations)
    .find(([, candidate]) => candidate.state === 'reserved' && sameDirectory(candidate.intent?.cwd, cwd));
  const worker = Object.entries(document.workers)
    .find(([sessionId, candidate]) => sessionId !== exceptSessionId
      && occupies(candidate) && sameDirectory(candidate.cwd, cwd));
  if (!operation && !worker) return;
  throw new OrchestrationError('ORCHESTRATION_CWD_BUSY', 'A managed worker holds this directory; use another worktree.', {
    ...(worker ? { sessionId: worker[0] } : { opId: operation[0] }),
  });
};

export const ensureOwner = (document, orchestratorSessionId, cwd) => {
  const owner = document.owners[orchestratorSessionId] ?? { generation: 1 };
  if (cwd && !owner.cwd) owner.cwd = cwd;
  document.owners[orchestratorSessionId] = owner;
  return owner;
};

/** The operation behind `opId`, refused when it no longer belongs to `caller`. */
export const ownedOperation = (document, opId, caller) => {
  const operation = document.operations[opId];
  if (!operation || operation.orchestratorSessionId !== caller) {
    throw new OrchestrationError('ORCHESTRATION_OWNER_CHANGED', 'This start now belongs to another orchestrator.', { opId });
  }
  return operation;
};

/**
 * Step `reserved`: look the request up by its key or reserve a new slot.
 * Returns the operation id; an existing open or created operation is reused.
 */
export const reserveSpawn = (document, { caller, clientRequestId, intent, workerLimit, hostGate, opId, at, process }) => {
  if (clientRequestId) {
    const existingId = document.requestKeys[requestKey(caller, clientRequestId)];
    const existing = existingId ? document.operations[existingId] : undefined;
    if (existing && (existing.state === 'reserved' || existing.state === 'created')) {
      ownedOperation(document, existingId, caller);
      return { opId: existingId, resumed: true };
    }
  }
  assertFreeSlot(document, workerLimit);
  assertHostIdle(hostGate);
  assertFreeDirectory(document, intent.cwd);
  document.operations[opId] = {
    kind: 'spawn',
    orchestratorSessionId: caller,
    clientRequestId: clientRequestId ?? null,
    intent,
    sessionId: null,
    state: 'reserved',
    step: 'reserved',
    steps: { reserved: { doneAt: at } },
    process,
    createdAt: at,
    stateSince: at,
  };
  if (clientRequestId) document.requestKeys[requestKey(caller, clientRequestId)] = opId;
  return { opId, resumed: false };
};

export const beginStep = (document, opId, caller, step, at, process) => {
  const operation = ownedOperation(document, opId, caller);
  if (step === 'session' && operation.state !== 'reserved') {
    throw new OrchestrationError('ORCHESTRATION_START_CLOSED', 'This start was closed meanwhile; retry the spawn.', { opId, state: operation.state });
  }
  operation.process = process;
  operation.step = step;
  operation.steps[step] = { startedAt: at };
  // The prompt step drives the worker's start; its stamp is the start's claim.
  const worker = operation.sessionId ? document.workers[operation.sessionId] : undefined;
  if (worker?.state === 'starting') worker.process = process;
  return operation;
};

export const finishStep = (operation, step, at, details = {}) => {
  operation.steps[step] = { ...operation.steps[step], ...details, doneAt: at };
};

/** Step `session` done: the worker is added in the same transaction. */
export const recordSession = (document, opId, caller, session, at) => {
  const operation = ownedOperation(document, opId, caller);
  // Only a held reservation may become a worker; an abandoned or failed start
  // already gave its slot away.
  if (operation.state !== 'reserved') {
    throw new OrchestrationError('ORCHESTRATION_START_CLOSED', 'This start was closed meanwhile; retry the spawn.', { opId, state: operation.state });
  }
  const { intent } = operation;
  finishStep(operation, 'session', at, { sessionId: session.sessionId });
  operation.sessionId = session.sessionId;
  operation.state = 'created';
  operation.stateSince = at;
  delete operation.recreate;
  document.workers[session.sessionId] = {
    orchestratorSessionId: caller,
    opId,
    cwd: session.cwd,
    title: intent.title,
    ...(intent.role ? { role: intent.role } : {}),
    ...(intent.profile ? { profile: intent.profile } : {}),
    ...(intent.model ? { model: intent.model } : {}),
    ...(intent.thinking ? { thinking: intent.thinking } : {}),
    ...(intent.issue ? { issue: intent.issue } : {}),
    ...(intent.branch ? { branch: intent.branch } : {}),
    ...(intent.servesPr ? { servesPr: intent.servesPr } : {}),
    ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
    ...(operation.process ? { process: operation.process } : {}),
    state: 'starting',
    stateSince: at,
    createdAt: at,
  };
  return document.workers[session.sessionId];
};

/** A failed step releases the reservation; nothing was created. */
export const failOperation = (document, opId, caller, step, message, at) => {
  const operation = ownedOperation(document, opId, caller);
  operation.state = 'failed';
  operation.stateSince = at;
  operation.error = { step, message, at };
};

/**
 * Pi rejected the first task. Pi persisted nothing, so the session is
 * ephemeral and goes away; the worker is stopped with reason `task_rejected`
 * and frees its slot and directory, and a retry with the same key starts a
 * new worker because only open operations are reused.
 */
export const rejectStart = (document, opId, caller, message, at) => {
  const operation = ownedOperation(document, opId, caller);
  operation.state = 'failed';
  operation.stateSince = at;
  operation.error = { step: 'prompted', message, at };
  const worker = operation.sessionId ? document.workers[operation.sessionId] : undefined;
  if (!worker) return;
  worker.state = 'stopped';
  worker.stateSince = at;
  worker.stoppedReason = 'task_rejected';
  delete worker.process;
};

const setWorkerState = (worker, state, at) => {
  worker.state = state;
  worker.stateSince = at;
};

/**
 * The durability check of a `starting` worker. `present`: the JSONL is on
 * disk, the worker is `active`. `absent`: Pi never wrote it, so the session
 * would vanish; the worker is removed and its operation goes back to
 * `reserved` with its slot for a retry. `unknown` changes nothing.
 */
export const applyDurability = (document, sessionId, presence, at) => {
  const worker = document.workers[sessionId];
  if (!worker || worker.state !== 'starting') return worker?.state;
  const operation = worker.opId ? document.operations[worker.opId] : undefined;
  if (presence === 'present') {
    setWorkerState(worker, 'active', at);
    if (operation) finishStep(operation, 'durable', at);
    return 'active';
  }
  if (presence === 'absent') {
    delete document.workers[sessionId];
    if (operation) {
      operation.state = 'reserved';
      operation.stateSince = at;
      operation.step = 'session';
      operation.sessionId = null;
      operation.recreate = true;
      // The vanished session keeps the opId in its lineage; a later lookup must
      // not take it for the recreated one.
      operation.replaced = [...(operation.replaced ?? []), sessionId];
      for (const step of ['session', 'prompted', 'durable']) delete operation.steps[step];
    }
    return 'removed';
  }
  return 'starting';
};

/**
 * A worker's run settled. The JSONL check comes first, then the `done` rule,
 * so a worker that reported `done` in its first durable run is `done` after
 * this one settle (R3-S1). The `done` rule applies only to the run that
 * settled: `generation` is the settled run's generation (null when this
 * process did not start it), and a later run's `done` report or start is not
 * touched by an earlier run's settle. `hold` defers the `done` rule while an
 * admitted input has no outcome yet, since that input may start the next run.
 * Nor does it apply while the worker shows an admission: that admission's
 * run, or its verdict, decides about the slot (R7-S1).
 */
export const applySettle = (document, sessionId, presence, at, { generation = null, hold = false } = {}) => {
  if (!document.workers[sessionId]) return undefined;
  applyDurability(document, sessionId, presence, at);
  const current = document.workers[sessionId];
  if (!current) return 'removed';
  const currentGeneration = current.generation ?? 0;
  // No generation is no proof: only the settle of the run that holds the
  // current generation may apply its `done`.
  if (hold || current.admission || generation === null || generation !== currentGeneration) return current.state;
  if ((current.doneReported === true || current.doneReported === currentGeneration) && current.state === 'active') {
    setWorkerState(current, 'done', at);
  }
  if (current.state !== 'starting') delete current.doneReported;
  return current.state;
};

/**
 * Input admission, taken by the daemon that holds the session lease right
 * before the prompt. Every input to a worker belongs to an admission, and its
 * `token` is the identity that every later step names: the commit of a run,
 * the release and the unresolved mark apply only while the worker still
 * shows that admission, and a stop deletes it. A `done` or `stopped` worker
 * takes a slot and its directory in the same transaction as the limit check
 * (`previous` is the state it goes back to); on a worker that already holds
 * a slot the admission takes none (`previous: null`). Inputs of the same
 * process share the open admission. Returns the admission's token.
 */
export const admitForInput = (document, sessionId, { workerLimit, token, at, process, ownsProcess }) => {
  const worker = document.workers[sessionId];
  if (!worker) return { worker: false };
  if (worker.stopping) {
    throw new OrchestrationError('ORCHESTRATION_WORKER_STOPPING', 'This worker is being stopped; retry once session_stop has finished.', { sessionId });
  }
  // Someone wrote to the worker; an open question stays open (slice 2).
  worker.lastInputAt = at;
  if (worker.admission) {
    if (ownsProcess(worker.admission.process)) return { worker: true, admission: worker.admission.token };
    throw new OrchestrationError('ORCHESTRATION_WORKER_BUSY', 'Another daemon is admitting an input to this worker; retry shortly.', { sessionId });
  }
  const reserves = RESTARTABLE_STATES.has(worker.state);
  if (reserves) {
    // A held worker already counts as a slot.
    if (!worker.hold) assertFreeSlot(document, workerLimit);
    assertFreeDirectory(document, worker.cwd, sessionId);
  }
  worker.admission = { token, previous: reserves ? worker.state : null, process, since: at, state: 'pending' };
  if (reserves) setWorkerState(worker, 'active', at);
  return { worker: true, admission: token };
};

const holdsAdmission = (worker, admission) => Boolean(admission) && worker?.admission?.token === admission;


/**
 * An input of `admission` started a run. The run takes the worker's slot as
 * a new generation, so nothing is counted twice; with other inputs of the
 * admission still open (`keep`), the admission stays without a slot of its
 * own. The admission is the shared claim on the slot; the run's identity is
 * its own `start` (the input's ticket), with `seq`, the order in which its
 * process saw the starts. `worker.run` names the start that holds the
 * current generation.
 */
const commitStart = (document, sessionId, at, { admission, start, seq, keep = false }) => {
  const worker = document.workers[sessionId];
  // Another admission the worker shows meanwhile stays untouched.
  if (holdsAdmission(worker, admission)) {
    if (keep) worker.admission = { ...worker.admission, previous: null };
    else delete worker.admission;
  }
  delete worker.doneReported;
  if (RESTARTABLE_STATES.has(worker.state)) setWorkerState(worker, 'active', at);
  worker.generation = (worker.generation ?? 0) + 1;
  worker.run = { admission, start, seq };
  return { generation: worker.generation };
};

/**
 * Records the start of a run, also as the retry of a commit that failed,
 * from that run's next registry step. Idempotent for the same `start` only.
 * A start is `stale`, and gets no generation, when a later start of the same
 * admission already holds the worker (a retried commit never takes over a
 * newer run's generation) or when the worker no longer shows its admission
 * (a stop deleted it).
 */
export const completeStart = (document, sessionId, at, { admission, start, seq, keep = false }) => {
  const worker = document.workers[sessionId];
  if (!worker || !start) return { stale: true };
  if (worker.run?.start === start) return { generation: worker.generation ?? 0 };
  if (worker.run?.admission === admission) {
    if (worker.run.seq > seq) return { stale: true };
    // A later start of the same admission, whose predecessor's commit gave
    // the admission back: it takes the next generation while the worker
    // still runs.
    if (!holdsAdmission(worker, admission)) {
      if (worker.stopping || !SLOT_WORKER_STATES.has(worker.state)) return { stale: true };
      return commitStart(document, sessionId, at, { admission, start, seq, keep });
    }
  }
  if (!holdsAdmission(worker, admission)) return { stale: true };
  return commitStart(document, sessionId, at, { admission, start, seq, keep });
};

/** Whether `start` holds the worker's current generation. */
export const holdsStart = (worker, start) => Boolean(start) && worker?.run?.start === start;

/**
 * Every input of `admission` ended without a run: a slot the admission took
 * goes back.
 */
export const releaseAdmission = (document, sessionId, at, admission) => {
  const worker = document.workers[sessionId];
  if (!holdsAdmission(worker, admission)) return false;
  const { previous } = worker.admission;
  delete worker.admission;
  if (previous && worker.state === 'active') setWorkerState(worker, previous, at);
  return true;
};

/**
 * Pi accepted an input of `admission` without saying whether it started a
 * run (a prompt deferred while the previous run settles). The slot stays,
 * and the registry shows the open admission so a watchdog can report it.
 */
export const markUnresolved = (document, sessionId, { admission, at }) => {
  const worker = document.workers[sessionId];
  if (!holdsAdmission(worker, admission)) return false;
  worker.admission = { ...worker.admission, state: 'unresolved', unresolvedAt: at };
  return true;
};

/**
 * Ends the `hold` a stop left for inputs it could not settle, once the
 * stopping process has proof for every one of them. Only the hold's own
 * token releases it.
 */
export const releaseHold = (document, sessionId, token) => {
  const worker = document.workers[sessionId];
  if (!worker?.hold || worker.hold.token !== token) return false;
  delete worker.hold;
  return true;
};

/**
 * Marks a worker as occupied by something its process cannot prove ended:
 * an input a stop could not settle, or a run that started without a slot.
 * The worker keeps a slot and its directory in any state until `releaseHold`
 * with the same token, or until reconcile finds the holder's process dead.
 * The hold is taken without the limit check, because the occupancy already
 * exists. An existing hold is kept and its token returned.
 */
export const setHold = (document, sessionId, { token, process, at, reason }) => {
  const worker = document.workers[sessionId];
  if (!worker) return undefined;
  worker.hold ??= { token, process, since: at, reason };
  return worker.hold.token;
};

/**
 * An occupancy whose end has no proof (a run whose prompt could not prove
 * its end): the worker shows a hold with reason `unproven_run`, taking one
 * with `token` if it has none. Only reconcile ends it, once its process died.
 */
export const holdUnproven = (document, sessionId, { token, process, at }) => {
  const worker = document.workers[sessionId];
  if (!worker) return undefined;
  worker.hold = worker.hold
    ? { ...worker.hold, reason: 'unproven_run' }
    : { token, process, since: at, reason: 'unproven_run' };
  return worker.hold.token;
};

/**
 * Stores a worker's report. An open question closes only through a matching
 * `resolves`; a new `question` or `blocked` while one is open must name
 * it there and then replaces it. A retry with the stored report's
 * `clientRequestId` changes nothing. Throws before any change, so a refused
 * report leaves the document as it was.
 */
export const recordReport = (document, sessionId, args, { at, questionId, repository = null }) => {
  const worker = document.workers[sessionId];
  if (!worker) {
    throw new OrchestrationError('ORCHESTRATION_NOT_WORKER', 'This session is no registered worker.', { sessionId });
  }
  if (args.clientRequestId && worker.report?.requestId === args.clientRequestId) {
    return { deduplicated: true, question: worker.question ?? null };
  }
  const open = worker.question;
  if (args.resolves !== undefined && open?.id !== args.resolves) {
    throw new OrchestrationError('ORCHESTRATION_QUESTION_UNKNOWN', 'resolves does not name your open question.', {
      openQuestion: open?.id ?? null,
    });
  }
  const asks = args.kind === 'question' || args.kind === 'blocked';
  if (asks && open && args.resolves !== open.id) {
    throw new OrchestrationError('ORCHESTRATION_QUESTION_OPEN', 'You already have an open question; name it in resolves to replace it.', {
      openQuestion: open.id,
    });
  }
  if (args.resolves !== undefined) delete worker.question;
  if (asks) {
    worker.question = {
      id: questionId, kind: args.kind, audience: args.audience, summary: args.summary, at,
      ...(args.brief ? { brief: args.brief } : {}),
    };
  }
  worker.report = {
    kind: args.kind,
    summary: args.summary,
    at,
    ...(args.pullRequest !== undefined ? { pullRequest: args.pullRequest } : {}),
    ...(args.noPullRequest !== undefined ? { noPullRequest: args.noPullRequest } : {}),
    ...(args.evidence ? { evidence: args.evidence } : {}),
    ...(args.clientRequestId ? { requestId: args.clientRequestId } : {}),
  };
  if (args.pullRequest !== undefined) worker.pullRequest = { number: args.pullRequest, repository };
  return { deduplicated: false, question: worker.question ?? null };
};

/** Closes the worker's open question when it is `questionId`. */
export const closeQuestion = (document, sessionId, questionId) => {
  const worker = document.workers[sessionId];
  if (!worker?.question || worker.question.id !== questionId) return false;
  delete worker.question;
  return true;
};

/**
 * #107 kept workers as JSONL entries in the orchestrator's session. They are
 * read once per orchestrator and then live here; stopped ones become
 * `stopped`, the others `active`.
 */
export const importLineage = (document, orchestratorSessionId, children, at) => {
  if (document.importedFromLineage.includes(orchestratorSessionId)) return 0;
  let imported = 0;
  for (const child of children) {
    if (document.workers[child.sessionId]) continue;
    document.workers[child.sessionId] = {
      orchestratorSessionId,
      opId: null,
      cwd: child.cwd,
      title: child.title,
      ...(child.role ? { role: child.role } : {}),
      ...(child.model ? { model: child.model } : {}),
      state: child.stopped ? 'stopped' : 'active',
      stateSince: at,
      createdAt: child.createdAt ?? at,
    };
    imported += 1;
  }
  document.importedFromLineage.push(orchestratorSessionId);
  return imported;
};

/**
 * Move every worker that is not `removed` and every open operation of `from`
 * to `to`, with retry keys for the new owner. A caller key that already maps
 * to another operation refuses the whole takeover before any change (R3-S2).
 */
export const takeOver = (document, { from, to, at, isRunning = () => false, isStopping = () => false }) => {
  // `isRunning(opId, operation)` says whether the step's process still runs it,
  // `isStopping(stamp)` whether a worker's stop claim is still being carried out.
  const operations = Object.entries(document.operations)
    .filter(([, operation]) => operation.orchestratorSessionId === from
      && (OPEN_OPERATION_STATES.has(operation.state) || operation.state === 'created'));
  // A step that started and did not finish in a live process is still running.
  const running = operations.filter(([opId, operation]) => {
    const step = operation.steps?.[operation.step];
    return step?.startedAt !== undefined && step.doneAt === undefined && step.endedAt === undefined
      && isRunning(opId, operation);
  });
  if (running.length > 0) {
    throw new OrchestrationError('ORCHESTRATION_TAKEOVER_BUSY', 'A start of that orchestrator is still running; retry when it finished.', { opIds: running.map(([opId]) => opId) });
  }
  const conflicts = [];
  for (const [opId, operation] of operations) {
    if (!operation.clientRequestId) continue;
    const existing = document.requestKeys[requestKey(to, operation.clientRequestId)];
    if (existing !== undefined && existing !== opId) conflicts.push(operation.clientRequestId);
  }
  if (conflicts.length > 0) {
    throw new OrchestrationError('ORCHESTRATION_TAKEOVER_KEY_CONFLICT', 'You already use these clientRequestIds for other starts.', { clientRequestIds: conflicts });
  }
  const workers = Object.entries(document.workers)
    .filter(([, worker]) => worker.orchestratorSessionId === from && worker.state !== 'removed');
  const stopping = workers.filter(([, worker]) => isStopping(worker.stopping));
  if (stopping.length > 0) {
    throw new OrchestrationError('ORCHESTRATION_TAKEOVER_BUSY', 'A stop of that orchestrator is still running; retry when it finished.', { sessionIds: stopping.map(([sessionId]) => sessionId) });
  }
  for (const [, worker] of workers) worker.orchestratorSessionId = to;
  for (const [opId, operation] of operations) {
    operation.orchestratorSessionId = to;
    if (operation.clientRequestId) document.requestKeys[requestKey(to, operation.clientRequestId)] = opId;
  }
  ensureOwner(document, from);
  ensureOwner(document, to);
  document.owners[from].generation += 1;
  document.owners[to].generation += 1;
  document.owners[to].tookOverAt = at;
  return {
    workers: workers.map(([sessionId]) => sessionId),
    operations: operations.map(([opId]) => opId),
  };
};
