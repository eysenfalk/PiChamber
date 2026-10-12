import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ORCHESTRATION_TOOLS } from './tool-contracts.js';
import {
  CHILD_ENTRY,
  LINEAGE_ENTRY,
  RESULT_MESSAGE,
  createOrchestrationService,
} from './orchestration-service.js';
import { createOrchestrationRegistryStore } from './registry-store.js';

const ROLES = {
  'task-hard': { modelId: 'claude-opus-5-5', thinking: 'high' },
  research: { modelId: 'claude-sonnet-5-5', thinking: 'medium' },
  small: { modelId: 'claude-haiku-5-5', thinking: 'low' },
  review: { modelId: 'gpt-6.1-sol', thinking: 'high' },
};

const createRuntime = ({ sessionId, cwd = '/work/main', lineage } = {}) => {
  const entries = [];
  const runtime = {
    cwd,
    delivered: [],
    session: {
      sessionId,
      sessionFile: `/sessions/${sessionId}.jsonl`,
      isStreaming: false,
      messages: [],
      sessionManager: {
        getEntries: () => entries,
        appendCustomEntry: (customType, data) => { entries.push({ type: 'custom', customType, data }); },
        getSessionName: () => `title ${sessionId}`,
      },
      sendCustomMessage: async (message, options) => { runtime.delivered.push({ message, options }); },
    },
  };
  if (lineage) runtime.session.sessionManager.appendCustomEntry(LINEAGE_ENTRY, lineage);
  return runtime;
};

const registryFile = () => join(mkdtempSync(join(tmpdir(), 'pichamber-orchestration-service-')), 'registry.json');

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const alivePids = new Set();
let nextPid = 1000;

/**
 * One daemon process. Two harnesses on the same `file` are two processes
 * sharing the durable registry; a new harness on the same file is a restart.
 */
const createHarness = ({ workerLimit = 4, activity = new Map(), now, file = registryFile(), workerPrefix = 'worker' } = {}) => {
  const runtimes = new Map();
  const states = new Map();
  // JSONL presence per worker; a settled worker got its assistant message.
  const fileStates = new Map();
  const add = (runtime) => { runtimes.set(runtime.session.sessionId, runtime); return runtime; };
  const orchestrator = add(createRuntime({ sessionId: 'orch' }));
  const registry = createOrchestrationRegistryStore({ file });
  let counter = 0;
  let service;
  const pid = nextPid++;
  alivePids.add(pid);
  // The daemon's one input path: the gate around a prompt that may start a run.
  const input = async (sessionId, { outcome = 'started' } = {}) => {
    const ticket = await service.beforeSessionInput(sessionId);
    let startedRun = false;
    try {
      if (outcome === 'rejected') throw Object.assign(new Error('rejected by preflight'), { code: 'PROMPT_REJECTED' });
      if (outcome === 'started') {
        states.set(sessionId, 'busy');
        startedRun = true;
      }
      return { accepted: true };
    } finally {
      await service.afterSessionInput(sessionId, ticket, { startedRun });
    }
  };
  const deps = {
    registry,
    activateSession: vi.fn(async (sessionId) => {
      const runtime = runtimes.get(sessionId);
      if (!runtime) throw Object.assign(new Error('missing'), { code: 'SESSION_NOT_FOUND' });
      return runtime;
    }),
    getLiveRuntime: (sessionId) => runtimes.get(sessionId),
    listLiveRuntimes: () => [...runtimes.values()],
    getSessionState: (sessionId) => states.get(sessionId) ?? (runtimes.has(sessionId) ? 'idle' : 'dormant'),
    createWorkerSession: vi.fn(async ({ cwd, lineage }) => {
      counter += 1;
      const runtime = add(createRuntime({ sessionId: `${workerPrefix}-${counter}`, cwd, lineage }));
      return { sessionId: runtime.session.sessionId, cwd, sessionFile: runtime.session.sessionFile };
    }),
    sendInput: vi.fn(async ({ sessionId }) => input(sessionId)),
    abortSession: vi.fn(async (sessionId) => { states.set(sessionId, 'idle'); }),
    readSettings: async () => ({ workerLimit, roles: ROLES }),
    listModels: async () => [
      { providerId: 'anthropic', modelId: 'claude-opus-5-5', available: true },
      { providerId: 'anthropic', modelId: 'claude-sonnet-5-5', available: true },
      { providerId: 'openai-codex', modelId: 'gpt-6.1-sol', available: true },
    ],
    hostStatus: () => ({ cpuCount: 8 }),
    resolveBranch: async () => 'main',
    getSessionActivity: (sessionId) => activity.get(sessionId),
    sessionFileState: async (sessionId) => fileStates.get(sessionId) ?? 'absent',
    findSessionByOperation: async ({ opId }) => {
      const runtime = [...runtimes.values()].find((candidate) => candidate.session.sessionManager.getEntries()
        .some((entry) => entry.customType === LINEAGE_ENTRY && entry.data?.opId === opId));
      return runtime ? { sessionId: runtime.session.sessionId, cwd: runtime.cwd, sessionFile: runtime.session.sessionFile } : undefined;
    },
    now,
    processId: pid,
    isProcessAlive: (candidate) => alivePids.has(candidate),
  };
  service = createOrchestrationService(deps);
  const settle = async (sessionId, assistant, { durable = true } = {}) => {
    const runtime = runtimes.get(sessionId);
    if (assistant) runtime.session.messages.push({ role: 'assistant', content: [{ type: 'text', text: assistant }] });
    if (durable && !fileStates.has(sessionId)) fileStates.set(sessionId, 'present');
    states.set(sessionId, 'idle');
    await service.onSessionSettled(sessionId, runtime);
  };
  const workers = async () => (await registry.read()).workers;
  // The process dies; its resident sessions die with it.
  const crash = () => { alivePids.delete(pid); };
  return { service, deps, runtimes, states, fileStates, orchestrator, settle, input, registry, workers, file, add, crash };
};

const expectCode = async (promise, code) => {
  await expect(promise).rejects.toMatchObject({ code });
};

/** A worker whose run settled after it reported `done`. */
const finishWorker = async (harness, sessionId) => {
  await harness.service.recordDoneReport(sessionId);
  await harness.settle(sessionId, 'finished');
  expect((await harness.workers())[sessionId].state).toBe('done');
};

describe('orchestration tool contracts', () => {
  it('offers exactly the owner\'s eleven roles to session_spawn', () => {
    const spawn = ORCHESTRATION_TOOLS.find((tool) => tool.name === 'session_spawn');
    expect(spawn.parameters.properties.role.enum).toEqual([
      'orchestrate', 'plan', 'oracle', 'debug', 'task-easy', 'task-medium', 'task-hard', 'task-extreme', 'research', 'small', 'review',
    ]);
  });
});

describe('orchestration service', () => {
  it('spawns a linked worker with the preamble, journals the start and reports it as a slot', async () => {
    const { service, deps, orchestrator, runtimes, registry } = createHarness();
    const spawned = await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'Fix the bug\nDetails', role: 'task-hard' });

    expect(spawned).toMatchObject({ sessionId: 'worker-1', cwd: '/work/a', title: 'Fix the bug', role: 'task-hard', state: 'busy' });
    expect(spawned.model).toEqual({ providerId: 'anthropic', modelId: 'claude-opus-5-5' });
    const { lineage } = deps.createWorkerSession.mock.calls[0][0];
    expect(deps.createWorkerSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/work/a', thinking: 'high', parentSessionPath: '/sessions/orch.jsonl' }));
    expect(lineage).toEqual({ parentSessionId: 'orch', parentDirectory: '/work/main', role: 'task-hard', opId: expect.stringMatching(/^op_/) });
    const [{ text, operationId }] = deps.sendInput.mock.calls[0];
    expect(text).toMatch(/^You are a worker session started by the PiChamber orchestrator session orch\./);
    expect(text.endsWith('Fix the bug\nDetails')).toBe(true);
    expect(operationId).toBe(`${lineage.opId}.task`);

    const document = await registry.read();
    expect(document.workers['worker-1']).toMatchObject({ orchestratorSessionId: 'orch', opId: lineage.opId, role: 'task-hard', state: 'starting' });
    expect(document.operations[lineage.opId]).toMatchObject({ state: 'created', sessionId: 'worker-1', step: 'prompted' });
    expect(Object.keys(document.operations[lineage.opId].steps)).toEqual(['reserved', 'session', 'prompted']);
    // The registry is the record; nothing is written into the orchestrator's JSONL.
    expect(orchestrator.session.sessionManager.getEntries()).toEqual([]);
    expect(service.isWorker(runtimes.get('worker-1').session.sessionManager)).toBe(true);
    expect(service.isWorker(orchestrator.session.sessionManager)).toBe(false);

    const capabilities = await service.call('orch', 'orchestration_capabilities');
    expect(capabilities).toMatchObject({ workerLimit: 4, freeSlots: 3, canSpawn: true, host: { cpuCount: 8 } });
    expect(capabilities.workers).toEqual([expect.objectContaining({ sessionId: 'worker-1', branch: 'main', state: 'busy', lifecycle: 'starting' })]);
  });

  it('makes a starting worker active once its JSONL is on disk', async () => {
    const harness = createHarness();
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await harness.settle('worker-1', 'first reply');
    expect((await harness.workers())['worker-1'].state).toBe('active');
  });

  it('enforces the worker limit until a worker is stopped', async () => {
    const { service } = createHarness({ workerLimit: 1 });
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');

    await service.call('orch', 'session_stop', { sessionId: 'worker-1' });
    await expect(service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' })).resolves.toMatchObject({ sessionId: 'worker-2' });
  });

  it('gives the last slot to exactly one of two racing spawns', async () => {
    const { service, deps } = createHarness({ workerLimit: 1 });
    const results = await Promise.allSettled([
      service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' }),
      service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected').reason).toMatchObject({ code: 'ORCHESTRATION_LIMIT' });
    expect(deps.createWorkerSession).toHaveBeenCalledTimes(1);
  });

  it('counts the slots of every orchestrator in the daemon', async () => {
    const harness = createHarness({ workerLimit: 1 });
    harness.add(createRuntime({ sessionId: 'orch-2' }));
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await expectCode(harness.service.call('orch-2', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');
  });

  it('rejects a second worker in a directory where a managed worker is busy', async () => {
    const { service } = createHarness();
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'two' }), 'ORCHESTRATION_CWD_BUSY');
  });

  it('keeps spawn, stop and takeover away from workers and stop away from foreign sessions', async () => {
    const { service, runtimes } = createHarness();
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await expectCode(service.call('worker-1', 'session_spawn', { cwd: '/work/b', task: 'x' }), 'ORCHESTRATION_FORBIDDEN');
    await expectCode(service.call('worker-1', 'session_stop', { sessionId: 'orch' }), 'ORCHESTRATION_FORBIDDEN');
    await expectCode(service.call('worker-1', 'orchestration_takeover', { fromSessionId: 'orch' }), 'ORCHESTRATION_FORBIDDEN');
    await expect(service.call('worker-1', 'orchestration_capabilities')).resolves.toMatchObject({ canSpawn: false });

    runtimes.set('other', createRuntime({ sessionId: 'other' }));
    await expectCode(service.call('orch', 'session_stop', { sessionId: 'other' }), 'ORCHESTRATION_FORBIDDEN');
    // Foreign sessions stay readable, steerable and interruptible.
    await expect(service.call('orch', 'session_send', { sessionId: 'other', text: 'hi', delivery: 'steer' })).resolves.toMatchObject({ accepted: true });
    await expect(service.call('orch', 'session_interrupt', { sessionId: 'other' })).resolves.toEqual({ sessionId: 'other', interrupted: true });
    await expect(service.call('orch', 'session_read', { sessionId: 'other' })).resolves.toMatchObject({ sessionId: 'other', cwd: '/work/main' });
  });

  it('deduplicates retried and concurrent spawns by clientRequestId', async () => {
    const { service, deps, registry } = createHarness();
    const args = { cwd: '/work/a', task: 'one', clientRequestId: 'req-1' };
    const [first, concurrent] = await Promise.all([
      service.call('orch', 'session_spawn', args),
      service.call('orch', 'session_spawn', args),
    ]);
    const retried = await service.call('orch', 'session_spawn', args);

    expect(deps.createWorkerSession).toHaveBeenCalledTimes(1);
    expect(deps.sendInput).toHaveBeenCalledTimes(1);
    expect(concurrent).toMatchObject({ sessionId: first.sessionId, deduplicated: true });
    expect(retried).toMatchObject({ sessionId: first.sessionId, deduplicated: true });
    const document = await registry.read();
    expect(Object.keys(document.operations)).toEqual([document.requestKeys['orch:req-1']]);
  });

  it('resumes a start whose session exists after a failed create call, so a retry gives one worker', async () => {
    const { service, deps, workers } = createHarness();
    deps.createWorkerSession.mockImplementationOnce(async (options) => {
      await deps.createWorkerSession(options);
      throw new Error('connection lost after create');
    });
    await expect(service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' }))
      .resolves.toMatchObject({ sessionId: 'worker-1' });
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' });
    expect(Object.keys(await workers())).toEqual(['worker-1']);
  });

  it('survives a crash after the session create and before the worker write: a retry gives one worker', async () => {
    const first = createHarness();
    const hang = deferred();
    first.deps.createWorkerSession.mockImplementationOnce(() => hang.promise);
    void first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' });
    await vi.waitFor(() => expect(first.deps.createWorkerSession).toHaveBeenCalled());

    // Restart: nothing reached disk, the resident session is gone.
    first.crash();
    const restarted = createHarness({ file: first.file, workerPrefix: 'after' });
    await expect(restarted.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' }))
      .resolves.toMatchObject({ sessionId: 'after-1' });
    const document = await restarted.registry.read();
    expect(Object.keys(document.workers)).toEqual(['after-1']);
    expect(Object.values(document.operations).map((operation) => operation.state).sort()).toEqual(['abandoned', 'created']);
  });

  it('survives a crash before the first assistant message: the start is reserved again and a retry gives one durable worker', async () => {
    const first = createHarness({ workerLimit: 2 });
    await first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' });

    // Restart: Pi never wrote the JSONL, so the session vanished.
    first.crash();
    const restarted = createHarness({ workerLimit: 2, file: first.file, workerPrefix: 'after' });
    const capabilities = await restarted.service.call('orch', 'orchestration_capabilities');
    expect(capabilities.freeSlots).toBe(1);
    expect(capabilities.workers).toEqual([]);
    const opId = (await restarted.registry.read()).requestKeys['orch:job-1'];
    expect((await restarted.registry.read()).operations[opId]).toMatchObject({ state: 'reserved', step: 'session', recreate: true });

    await expect(restarted.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' }))
      .resolves.toMatchObject({ sessionId: 'after-1' });
    await restarted.settle('after-1', 'reply');
    const document = await restarted.registry.read();
    expect(Object.keys(document.workers)).toEqual(['after-1']);
    expect(document.workers['after-1'].state).toBe('active');
    expect(document.operations[opId]).toMatchObject({ state: 'created', sessionId: 'after-1' });
  });

  it('leaves the open start of another live daemon process alone', async () => {
    const first = createHarness();
    const hang = deferred();
    first.deps.createWorkerSession.mockImplementationOnce(() => hang.promise);
    void first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' }).catch(() => {});
    await vi.waitFor(() => expect(first.deps.createWorkerSession).toHaveBeenCalled());

    const second = createHarness({ file: first.file });
    await second.service.call('orch', 'orchestration_capabilities');
    const opId = (await second.registry.read()).requestKeys['orch:job-1'];
    expect((await second.registry.read()).operations[opId].state).toBe('reserved');
  });

  it('keeps workers and roles across a restart', async () => {
    const first = createHarness();
    await first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', role: 'research' });
    await first.settle('worker-1', 'reply');

    first.crash();
    const restarted = createHarness({ file: first.file });
    restarted.add(createRuntime({ sessionId: 'worker-1', cwd: '/work/a' }));
    const listed = await restarted.service.call('orch', 'session_list', {});
    expect(listed.sessions).toEqual([expect.objectContaining({ sessionId: 'worker-1', role: 'research', lifecycle: 'active', cwd: '/work/a' })]);
  });

  it('holds the slot of a worker that reported done until its held-open turn settles', async () => {
    const harness = createHarness({ workerLimit: 1 });
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await harness.settle('worker-1', 'first');
    await harness.service.call('orch', 'session_send', { sessionId: 'worker-1', text: 'more' });

    await harness.service.recordDoneReport('worker-1');
    await expectCode(harness.service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');
    await harness.settle('worker-1', 'finished');
    expect((await harness.workers())['worker-1'].state).toBe('done');
    await expect(harness.service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' })).resolves.toMatchObject({ sessionId: 'worker-2' });
  });

  it('makes a worker that reports done in its first durable turn done after that one settle', async () => {
    const harness = createHarness({ workerLimit: 1 });
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await harness.service.recordDoneReport('worker-1');
    await harness.settle('worker-1', 'finished at once');
    expect((await harness.workers())['worker-1'].state).toBe('done');
    await expect(harness.service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' })).resolves.toMatchObject({ sessionId: 'worker-2' });
  });

  it('gives the last slot to one of a UI prompt and a session_send racing for two done workers', async () => {
    const harness = createHarness({ workerLimit: 2 });
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' });
    await finishWorker(harness, 'worker-1');
    await finishWorker(harness, 'worker-2');
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/c', task: 'three' });

    const results = await Promise.allSettled([
      harness.input('worker-1'),
      harness.service.call('orch', 'session_send', { sessionId: 'worker-2', text: 'again' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected').reason).toMatchObject({ code: 'ORCHESTRATION_LIMIT' });
    const states = Object.values(await harness.workers()).map((worker) => worker.state).sort();
    expect(states).toEqual(['active', 'done', 'starting']);
  });

  it('returns the slot when an input to a done worker starts no run, and keeps it for a parallel input that does', async () => {
    const harness = createHarness({ workerLimit: 1 });
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await finishWorker(harness, 'worker-1');

    await expect(harness.input('worker-1', { outcome: 'rejected' })).rejects.toThrow('rejected by preflight');
    expect((await harness.workers())['worker-1'].state).toBe('done');
    await harness.input('worker-1', { outcome: 'handled' });
    expect((await harness.workers())['worker-1'].state).toBe('done');

    await Promise.all([harness.input('worker-1', { outcome: 'handled' }), harness.input('worker-1')]);
    expect((await harness.workers())['worker-1'].state).toBe('active');
    await expectCode(harness.service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');
  });

  it('resolves waits when a worker settles and reports timeouts otherwise', async () => {
    const { service, settle } = createHarness();
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });

    await expect(service.call('orch', 'session_wait', { sessionIds: ['worker-1'], timeoutMs: 10 }))
      .resolves.toMatchObject({ timedOut: true, sessions: [{ sessionId: 'worker-1', state: 'busy' }] });

    const waiting = service.call('orch', 'session_wait', { sessionIds: ['worker-1'], timeoutMs: 5_000 });
    await vi.waitFor(() => expect(service.call).toBeDefined());
    await settle('worker-1', 'done here');
    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      sessions: [{ sessionId: 'worker-1', state: 'idle', outcome: 'completed', lastReply: 'done here' }],
    });
  });

  it('shows a stuck, retrying, blocked or failed worker in list and read', async () => {
    const activity = new Map();
    const { service, runtimes, states, settle } = createHarness({ activity, now: () => 100_000 });
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' });
    runtimes.get('worker-1').session.messages.push({ role: 'user', content: 'one', timestamp: 40_000 });
    activity.set('worker-1', { runStartedAt: 30_000, waitingForInput: true });
    states.set('worker-2', 'retry');
    activity.set('worker-2', { runStartedAt: 90_000, retry: { attempt: 2, message: '400 invalid thinking', next: 1 } });

    const listed = await service.call('orch', 'session_list', {});
    expect(listed.sessions).toEqual([
      expect.objectContaining({ sessionId: 'worker-1', state: 'busy', activity: { runningForMs: 70_000, quietForMs: 60_000, waitingForInput: true } }),
      expect.objectContaining({ sessionId: 'worker-2', state: 'retry', activity: { runningForMs: 10_000, retry: { attempt: 2, error: '400 invalid thinking' } } }),
    ]);

    runtimes.get('worker-2').session.messages.push({ role: 'assistant', content: [], stopReason: 'error', errorMessage: '400 invalid thinking' });
    await settle('worker-2');
    const read = await service.call('orch', 'session_read', { sessionId: 'worker-2' });
    expect(read).toMatchObject({ state: 'idle', outcome: 'error', error: '400 invalid thinking' });
    expect(read).not.toHaveProperty('activity');
    await expect(service.call('orch', 'session_list', { scope: 'all' })).resolves.toMatchObject({
      sessions: expect.arrayContaining([expect.objectContaining({ sessionId: 'worker-2', outcome: 'error', error: '400 invalid thinking' })]),
    });
  });

  it('spawns in wait mode without ever cancelling the worker', async () => {
    const { service, deps, settle } = createHarness();
    await expect(service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', mode: 'wait', timeoutMs: 10 }))
      .resolves.toMatchObject({ sessionId: 'worker-1', state: 'busy', timedOut: true });
    expect(deps.abortSession).not.toHaveBeenCalled();

    const waiting = service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two', mode: 'wait', timeoutMs: 5_000 });
    await vi.waitFor(() => expect(deps.sendInput).toHaveBeenCalledTimes(2));
    await settle('worker-2', 'second done');
    await expect(waiting).resolves.toMatchObject({ sessionId: 'worker-2', state: 'idle', timedOut: false, lastReply: 'second done' });
  });

  it('lets an explicit model and thinking override the role and reports the unfiltered catalog', async () => {
    const { service, deps } = createHarness();
    const spawned = await service.call('orch', 'session_spawn', {
      cwd: '/work/a',
      task: 'one',
      role: 'small',
      model: { modelId: 'gpt-6.1-sol' },
      thinking: 'max',
    });
    expect(spawned.model).toEqual({ providerId: 'openai-codex', modelId: 'gpt-6.1-sol' });
    expect(deps.createWorkerSession).toHaveBeenCalledWith(expect.objectContaining({ thinking: 'max' }));

    const capabilities = await service.call('orch', 'orchestration_capabilities');
    expect(capabilities.models.map((model) => model.modelId)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol']);
    expect(capabilities.roles.review).toEqual(ROLES.review);
  });

  it('sends to any session and forwards clientRequestId as the idempotent operation id', async () => {
    const { service, deps, runtimes } = createHarness();
    runtimes.set('owner-session', createRuntime({ sessionId: 'owner-session' }));
    deps.sendInput.mockResolvedValueOnce({ accepted: true }).mockResolvedValueOnce({ accepted: true, deduplicated: true });

    await expect(service.call('orch', 'session_send', { sessionId: 'owner-session', text: 'hi', delivery: 'steer', clientRequestId: 'send-1' }))
      .resolves.toMatchObject({ sessionId: 'owner-session', accepted: true });
    await expect(service.call('orch', 'session_send', { sessionId: 'owner-session', text: 'hi', delivery: 'steer', clientRequestId: 'send-1' }))
      .resolves.toMatchObject({ deduplicated: true });
    expect(deps.sendInput).toHaveBeenNthCalledWith(1, { sessionId: 'owner-session', text: 'hi', delivery: 'steer', operationId: 'send-1' });
    expect(deps.sendInput).toHaveBeenNthCalledWith(2, { sessionId: 'owner-session', text: 'hi', delivery: 'steer', operationId: 'send-1' });
  });

  it('caps waits at the adapter limit', async () => {
    const { service } = createHarness();
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    const started = Date.now();
    const result = await service.call('orch', 'session_wait', { sessionIds: ['worker-1'], timeoutMs: 60_000 }, { maxWaitMs: 20 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('delivers a settled worker result to its owner as a turn-starting custom message', async () => {
    const { service, orchestrator, settle } = createHarness();
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', role: 'research' });
    await settle('worker-1', 'research result');

    expect(orchestrator.delivered).toHaveLength(1);
    const [{ message, options }] = orchestrator.delivered;
    expect(options).toEqual({ triggerTurn: true, deliverAs: 'followUp' });
    expect(message).toMatchObject({
      customType: RESULT_MESSAGE,
      display: true,
      details: { sessionId: 'worker-1', outcome: 'completed', role: 'research', cwd: '/work/a' },
    });
    expect(message.content).toContain('research result');
  });

  it('stops a worker without delivering the stopped result', async () => {
    const { service, deps, orchestrator, settle, workers } = createHarness();
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });

    const stopped = await service.call('orch', 'session_stop', { sessionId: 'worker-1' });
    expect(stopped.stopped).toEqual(['worker-1']);
    expect(deps.abortSession).toHaveBeenCalledWith('worker-1');
    expect((await workers())['worker-1'].state).toBe('stopped');

    await settle('worker-1', 'late');
    expect(orchestrator.delivered).toHaveLength(0);
    await expect(service.call('orch', 'session_stop', { sessionId: 'worker-1' })).resolves.toMatchObject({ alreadyStopped: true });
  });

  it('rejects unknown models, retired roles and relative directories', async () => {
    const { service } = createHarness();
    for (const role of ['implementation', 'implement', 'task']) {
      await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'x', role }), 'INVALID_ARGUMENT');
    }
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'x', model: { modelId: 'nope' } }), 'ORCHESTRATION_MODEL_UNAVAILABLE');
    await expectCode(service.call('orch', 'session_spawn', { cwd: 'relative', task: 'x' }), 'INVALID_ARGUMENT');
    await expectCode(service.call('orch', 'no_such_tool'), 'UNKNOWN_TOOL');
  });

  it('lets a spawn retry share a first task that is still being accepted', async () => {
    const { service, deps } = createHarness({ workerLimit: 1 });
    let reject;
    deps.sendInput.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const first = service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job' });
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
    const retry = service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job' });
    reject(Object.assign(new Error('no auth'), { code: 'PROVIDER_AUTH_REQUIRED' }));

    await expectCode(first, 'PROVIDER_AUTH_REQUIRED');
    await expectCode(retry, 'PROVIDER_AUTH_REQUIRED');
    expect(deps.createWorkerSession).toHaveBeenCalledTimes(1);
    await expect(service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job' }))
      .resolves.toMatchObject({ sessionId: 'worker-2', state: 'busy' });
  });

  it('keeps a newer send pending when an older send retry returns its stored receipt', async () => {
    const { service, deps, states } = createHarness();
    states.set('orch', 'idle');
    const releases = [];
    deps.sendInput.mockImplementation(() => new Promise((resolve) => { releases.push(resolve); }));
    const retry = service.call('orch', 'session_send', { sessionId: 'orch', text: 'a', clientRequestId: 'a' });
    const fresh = service.call('orch', 'session_send', { sessionId: 'orch', text: 'b', clientRequestId: 'b' });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[0]({ accepted: true, deduplicated: true });
    await retry;

    expect((await service.call('orch', 'session_read', { sessionId: 'orch' })).state).toBe('starting');
    releases[1]({ accepted: true });
    await fresh;
    expect((await service.call('orch', 'session_read', { sessionId: 'orch' })).state).toBe('starting');
  });

  it('delivers the settled turn on a retry even after the worker ran another turn', async () => {
    const { service, orchestrator, settle } = createHarness();
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    let failFirst = true;
    const send = orchestrator.session.sendCustomMessage;
    orchestrator.session.sendCustomMessage = async (message, options) => {
      if (failFirst) {
        failFirst = false;
        // The worker finishes another turn while the first delivery is retried.
        await settle('worker-1', 'second');
        throw Object.assign(new Error('closed'), { code: 'RUNTIME_DISPOSED' });
      }
      return send(message, options);
    };
    await settle('worker-1', 'first');

    expect(orchestrator.delivered.map(({ message }) => message.content.split('\n\n').at(-1))).toEqual(['second', 'first']);
  });

  it('does not report a caller as gone when its lookup failed on storage errors', async () => {
    const { service, deps } = createHarness();
    deps.activateSession.mockRejectedValueOnce(Object.assign(new Error('unreadable'), { code: 'INVALID_SESSION', incomplete: true }));
    await expectCode(service.call('missing', 'session_read', { sessionId: 'orch' }), 'SESSION_LOOKUP_FAILED');
    await expectCode(service.call('missing', 'session_read', { sessionId: 'orch' }), 'ORCHESTRATION_CALLER_GONE');
  });
});

describe('orchestration takeover', () => {
  it('moves an idle and a done worker; the old orchestrator can no longer stop them and results reach the new owner', async () => {
    const harness = createHarness();
    const successor = harness.add(createRuntime({ sessionId: 'orch-2' }));
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', role: 'research' });
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' });
    await harness.settle('worker-1', 'idle now');
    await finishWorker(harness, 'worker-2');
    harness.orchestrator.delivered.length = 0;

    await expect(harness.service.call('orch-2', 'orchestration_takeover', { fromSessionId: 'orch' }))
      .resolves.toMatchObject({ fromSessionId: 'orch', workers: ['worker-1', 'worker-2'] });
    const listed = await harness.service.call('orch-2', 'session_list', {});
    expect(listed.sessions.map((worker) => [worker.sessionId, worker.lifecycle])).toEqual([['worker-1', 'active'], ['worker-2', 'done']]);
    await expect(harness.service.call('orch', 'session_list', {})).resolves.toEqual({ sessions: [] });
    await expectCode(harness.service.call('orch', 'session_stop', { sessionId: 'worker-1' }), 'ORCHESTRATION_FORBIDDEN');

    await harness.service.call('orch-2', 'session_send', { sessionId: 'worker-1', text: 'more' });
    await harness.settle('worker-1', 'for the successor');
    expect(harness.orchestrator.delivered).toHaveLength(0);
    expect(successor.delivered.map((entry) => entry.message.details.sessionId)).toEqual(['worker-1']);
    await expect(harness.service.call('orch-2', 'session_stop', { sessionId: 'worker-1' })).resolves.toMatchObject({ stopped: ['worker-1'] });
  });

  it('refuses a takeover while the old orchestrator runs or from itself', async () => {
    const harness = createHarness();
    harness.add(createRuntime({ sessionId: 'orch-2' }));
    harness.states.set('orch', 'busy');
    await expectCode(harness.service.call('orch-2', 'orchestration_takeover', { fromSessionId: 'orch' }), 'ORCHESTRATION_TAKEOVER_BUSY');
    await expectCode(harness.service.call('orch-2', 'orchestration_takeover', { fromSessionId: 'orch-2' }), 'INVALID_ARGUMENT');
  });

  it('refuses a takeover whose retry key the caller already uses, and changes nothing', async () => {
    const harness = createHarness();
    harness.add(createRuntime({ sessionId: 'orch-2' }));
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' });
    await harness.service.call('orch-2', 'session_spawn', { cwd: '/work/b', task: 'two', clientRequestId: 'job-1' });
    const before = JSON.stringify(await harness.registry.read());

    await expectCode(harness.service.call('orch-2', 'orchestration_takeover', { fromSessionId: 'orch' }), 'ORCHESTRATION_TAKEOVER_KEY_CONFLICT');
    expect(JSON.stringify(await harness.registry.read())).toBe(before);
  });

  it('lets the new owner finish a partial start once and refuses the late write of the old call', async () => {
    const old = createHarness();
    const hang = deferred();
    old.deps.createWorkerSession.mockImplementationOnce(async (options) => {
      await hang.promise;
      return { sessionId: 'late-session', cwd: options.cwd };
    });
    const lateCall = old.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' });
    await vi.waitFor(() => expect(old.deps.createWorkerSession).toHaveBeenCalled());

    // A second daemon process sharing the registry: orch-2 takes over and retries.
    const successor = createHarness({ file: old.file, workerPrefix: 'new' });
    successor.add(createRuntime({ sessionId: 'orch-2' }));
    successor.add(createRuntime({ sessionId: 'orch' }));
    await expect(successor.service.call('orch-2', 'orchestration_takeover', { fromSessionId: 'orch' }))
      .resolves.toMatchObject({ operations: [expect.stringMatching(/^op_/)] });
    await expect(successor.service.call('orch-2', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' }))
      .resolves.toMatchObject({ sessionId: 'new-1' });

    hang.resolve();
    await expect(lateCall).rejects.toMatchObject({ code: 'ORCHESTRATION_OWNER_CHANGED' });
    const document = await successor.registry.read();
    expect(Object.keys(document.operations)).toHaveLength(1);
    expect(Object.keys(document.workers)).toEqual(['new-1']);
    expect(document.workers['new-1'].orchestratorSessionId).toBe('orch-2');
  });

  it('imports the workers of a JSONL-only orchestrator once', async () => {
    const harness = createHarness();
    harness.add(createRuntime({ sessionId: 'orch-2' }));
    const legacy = harness.add(createRuntime({ sessionId: 'legacy' }));
    legacy.session.sessionManager.appendCustomEntry(CHILD_ENTRY, { sessionId: 'old-1', cwd: '/work/x', title: 'old one', role: 'research' });
    legacy.session.sessionManager.appendCustomEntry(CHILD_ENTRY, { sessionId: 'old-2', cwd: '/work/y', title: 'old two' });
    legacy.session.sessionManager.appendCustomEntry('pichamber.orchestration.stopped', { sessionId: 'old-2' });

    await harness.service.call('orch-2', 'orchestration_takeover', { fromSessionId: 'legacy' });
    const document = await harness.registry.read();
    expect(document.workers['old-1']).toMatchObject({ orchestratorSessionId: 'orch-2', state: 'active', role: 'research' });
    expect(document.workers['old-2']).toMatchObject({ orchestratorSessionId: 'orch-2', state: 'stopped' });
    expect(document.importedFromLineage).toEqual(expect.arrayContaining(['legacy']));

    // A later child entry is not read again, also not by another process.
    legacy.session.sessionManager.appendCustomEntry(CHILD_ENTRY, { sessionId: 'old-3', cwd: '/work/z', title: 'old three' });
    const other = createHarness({ file: harness.file });
    other.add(legacy);
    await other.service.call('legacy', 'session_list', {});
    expect((await other.registry.read()).workers['old-3']).toBeUndefined();
  });
});
