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

/** Reserved operations plus `starting` and `active` workers, across the daemon. */
export const slotsInUse = (document) => (
  Object.values(document.operations).filter((operation) => operation.state === 'reserved').length
  + Object.values(document.workers).filter((worker) => SLOT_WORKER_STATES.has(worker.state)).length
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
      && SLOT_WORKER_STATES.has(candidate.state) && sameDirectory(candidate.cwd, cwd));
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
export const reserveSpawn = (document, { caller, clientRequestId, intent, workerLimit, opId, at, process }) => {
  if (clientRequestId) {
    const existingId = document.requestKeys[requestKey(caller, clientRequestId)];
    const existing = existingId ? document.operations[existingId] : undefined;
    if (existing && (existing.state === 'reserved' || existing.state === 'created')) {
      ownedOperation(document, existingId, caller);
      return { opId: existingId, resumed: true };
    }
  }
  assertFreeSlot(document, workerLimit);
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
    ...(intent.model ? { model: intent.model } : {}),
    ...(intent.thinking ? { thinking: intent.thinking } : {}),
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
      for (const step of ['session', 'prompted', 'durable']) delete operation.steps[step];
    }
    return 'removed';
  }
  return 'starting';
};

/**
 * A worker's run settled. The JSONL check comes first, then the `done` rule,
 * so a worker that reported `done` in its first durable run is `done` after
 * this one settle (R3-S1).
 */
export const applySettle = (document, sessionId, presence, at) => {
  const worker = document.workers[sessionId];
  if (!worker) return undefined;
  applyDurability(document, sessionId, presence, at);
  const current = document.workers[sessionId];
  if (!current) return 'removed';
  delete current.gate;
  if (current.doneReported && current.state === 'active') {
    setWorkerState(current, 'done', at);
  }
  if (current.state !== 'starting') delete current.doneReported;
  return current.state;
};

/**
 * Input gate. A `done` or `stopped` worker takes a slot before a new run
 * starts, in the same transaction as the limit check. Returns the gate token,
 * or null when the input needs no slot.
 */
export const reserveForInput = (document, sessionId, { workerLimit, token, at, process }) => {
  const worker = document.workers[sessionId];
  if (!worker || !RESTARTABLE_STATES.has(worker.state)) return null;
  assertFreeSlot(document, workerLimit);
  assertFreeDirectory(document, worker.cwd, sessionId);
  worker.gate = { token, previous: worker.state, process };
  setWorkerState(worker, 'active', at);
  return token;
};

/** The input started no run: return the slot if this token still holds it. */
export const releaseInput = (document, sessionId, token, at) => {
  const worker = document.workers[sessionId];
  if (!worker?.gate || worker.gate.token !== token) return false;
  const { previous } = worker.gate;
  delete worker.gate;
  if (worker.state !== 'active') return false;
  setWorkerState(worker, previous, at);
  return true;
};

/** The input started a run: it keeps the slot until that run settles. */
export const keepInput = (document, sessionId, token) => {
  const worker = document.workers[sessionId];
  if (worker?.gate?.token === token) delete worker.gate;
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
