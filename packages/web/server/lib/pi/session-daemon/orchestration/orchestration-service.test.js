import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { SUPPORTED_KEYWORDS } from './contract-validator.js';
import { ORCHESTRATION_TOOLS } from './tool-contracts.js';
import {
  CHILD_ENTRY,
  LINEAGE_ENTRY,
  RESULT_MESSAGE,
  createOrchestrationService,
} from './orchestration-service.js';
import { createOrchestrationRegistryStore } from './registry-store.js';
import { findPersistedSessionByOperation } from './session-lookup.js';

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
// Kernel start time per pid; a reused pid gets a new one.
const startTimes = new Map();
let nextInstance = 0;

/**
 * One daemon process. Two harnesses on the same `file` are two processes
 * sharing the durable registry; a new harness on the same file is a restart.
 */
const createHarness = ({ workerLimit = 4, activity = new Map(), now, file = registryFile(), workerPrefix = 'worker', delay = async () => {}, pid: reusedPid, startTime, holdSession } = {}) => {
  const runtimes = new Map();
  const states = new Map();
  // JSONL presence per worker; a settled worker got its assistant message.
  const fileStates = new Map();
  const add = (runtime) => { runtimes.set(runtime.session.sessionId, runtime); return runtime; };
  const orchestrator = add(createRuntime({ sessionId: 'orch' }));
  const registry = createOrchestrationRegistryStore({ file });
  let counter = 0;
  let service;
  const pid = reusedPid ?? nextPid++;
  if (startTime !== undefined) startTimes.set(pid, startTime);
  nextInstance += 1;
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
    sessionFileState: vi.fn(async (sessionId) => fileStates.get(sessionId) ?? 'absent'),
    findSessionByOperation: vi.fn(async ({ opId }) => {
      const runtime = [...runtimes.values()].find((candidate) => candidate.session.sessionManager.getEntries()
        .some((entry) => entry.customType === LINEAGE_ENTRY && entry.data?.opId === opId));
      return runtime ? { sessionId: runtime.session.sessionId, cwd: runtime.cwd, sessionFile: runtime.session.sessionFile } : undefined;
    }),
    now,
    canonicalDirectory: async (directory) => resolve(directory),
    delay: vi.fn(delay),
    onDeliveryFailed: vi.fn(),
    ...(holdSession ? { holdSession } : {}),
    processId: pid,
    processInstance: `process-${pid}-${nextInstance}`,
    processStartTime: (candidate) => startTimes.get(candidate) ?? null,
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

  it('uses only schema keywords the core validator enforces', () => {
    const keywords = new Set();
    const walk = (schema) => {
      for (const [key, value] of Object.entries(schema)) {
        keywords.add(key);
        if (key === 'properties') Object.values(value).forEach(walk);
        if (key === 'items') walk(value);
      }
    };
    ORCHESTRATION_TOOLS.forEach((tool) => walk(tool.parameters));
    expect([...keywords].filter((keyword) => !SUPPORTED_KEYWORDS.has(keyword))).toEqual([]);
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

  it('admits concurrent spawns with different keys only up to the limit and once per directory', async () => {
    const { service, deps } = createHarness({ workerLimit: 2 });
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const create = deps.createWorkerSession.getMockImplementation();
    deps.createWorkerSession.mockImplementation(async (input) => { await gate; return create(input); });

    const atLimit = [
      service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two', clientRequestId: 'two' }),
      service.call('orch', 'session_spawn', { cwd: '/work/c', task: 'three', clientRequestId: 'three' }),
    ].map((promise) => promise.then(() => 'ok', (error) => error.code));
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    release();
    expect((await Promise.all(atLimit)).sort()).toEqual(['ORCHESTRATION_LIMIT', 'ok']);
    expect(deps.createWorkerSession).toHaveBeenCalledTimes(2);
  });

  it('admits one concurrent spawn per directory, also under another spelling of the path', async () => {
    const { service, deps } = createHarness();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const create = deps.createWorkerSession.getMockImplementation();
    deps.createWorkerSession.mockImplementation(async (input) => { await gate; return create(input); });

    const sameTree = [
      service.call('orch', 'session_spawn', { cwd: '/work/tree', task: 'one', clientRequestId: 'one' }),
      service.call('orch', 'session_spawn', { cwd: '/work/tree/.', task: 'two', clientRequestId: 'two' }),
    ].map((promise) => promise.then(() => 'ok', (error) => error.code));
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    release();
    expect((await Promise.all(sameTree)).sort()).toEqual(['ORCHESTRATION_CWD_BUSY', 'ok']);
    // Settled workers do not hold the directory; a later spelling still matches.
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/x/../tree', task: 'three' }), 'ORCHESTRATION_CWD_BUSY');
  });

  it('frees the reservation when worker creation fails', async () => {
    const { service, deps } = createHarness({ workerLimit: 1 });
    deps.createWorkerSession.mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'CREATE_FAILED' }));
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' }), 'CREATE_FAILED');
    await expect(service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' })).resolves.toMatchObject({ state: 'busy' });
  });

  it('starts a new worker when a spawn retry follows a rejected first task', async () => {
    const { service, deps, registry } = createHarness({ workerLimit: 1 });
    deps.sendInput.mockRejectedValueOnce(Object.assign(new Error('no auth'), { code: 'PROVIDER_AUTH_REQUIRED' }));
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job' }), 'PROVIDER_AUTH_REQUIRED');
    await expect(service.call('orch', 'orchestration_capabilities')).resolves.toMatchObject({ freeSlots: 1, workers: [] });

    const retried = await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job' });
    expect(retried).toMatchObject({ sessionId: 'worker-2', state: 'busy' });
    expect(retried.deduplicated).toBeUndefined();
    // A new start operation, so the task is not deduplicated against the rejected one.
    const [first, second] = deps.sendInput.mock.calls.map(([input]) => input);
    expect(second).toMatchObject({ sessionId: 'worker-2', operationId: expect.stringMatching(/^op_.*\.task$/) });
    expect(second.operationId).not.toBe(first.operationId);
    const { workers } = await registry.read();
    expect(workers['worker-1']).toMatchObject({ state: 'stopped', stoppedReason: 'task_rejected' });
    expect(workers['worker-2']).toMatchObject({ state: 'starting' });
  });

  it('keeps a session idle when a send retry only returns the stored receipt', async () => {
    const { service, deps, settle } = createHarness();
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await service.call('orch', 'session_send', { sessionId: 'worker-1', text: 'more', delivery: 'followUp', clientRequestId: 'more' });
    await settle('worker-1', 'done');
    deps.sendInput.mockResolvedValueOnce({ accepted: true, deduplicated: true });

    await expect(service.call('orch', 'session_send', { sessionId: 'worker-1', text: 'more', delivery: 'followUp', clientRequestId: 'more' }))
      .resolves.toMatchObject({ deduplicated: true, state: 'idle' });
    await expect(service.call('orch', 'session_wait', { sessionIds: ['worker-1'], timeoutMs: 1_000 }))
      .resolves.toMatchObject({ timedOut: false, sessions: [expect.objectContaining({ state: 'idle' })] });
  });

  it('ends a pending run when a send completes without an agent turn', async () => {
    const { service, deps, states } = createHarness();
    deps.sendInput.mockResolvedValueOnce({ accepted: true });
    states.set('orch', 'idle');
    await service.call('orch', 'session_send', { sessionId: 'orch', text: '/handled-command' });
    expect((await service.call('orch', 'session_read', { sessionId: 'orch' })).state).toBe('starting');
    service.onInputCompleted('orch');
    await expect(service.call('orch', 'session_wait', { sessionIds: ['orch'], timeoutMs: 1_000 })).resolves.toMatchObject({ timedOut: false });
  });

  it('keeps the slot and reports a failed stop until an abort succeeds', async () => {
    const { service, deps, orchestrator, settle } = createHarness();
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    deps.abortSession.mockRejectedValueOnce(Object.assign(new Error('sdk'), { code: 'ABORT_REJECTED' }));

    await expect(service.call('orch', 'session_stop', { sessionId: 'worker-1' })).rejects.toMatchObject({
      code: 'ORCHESTRATION_STOP_FAILED',
      details: { stopped: [], failed: [{ sessionId: 'worker-1', code: 'ABORT_REJECTED' }] },
    });
    await expect(service.call('orch', 'orchestration_capabilities')).resolves.toMatchObject({ freeSlots: 3, workers: [expect.objectContaining({ state: 'busy' })] });

    await expect(service.call('orch', 'session_stop', { sessionId: 'worker-1' })).resolves.toEqual({ sessionId: 'worker-1', stopped: ['worker-1'] });
    await settle('worker-1', 'late');
    expect(orchestrator.delivered).toHaveLength(0);
  });

  it('counts a worker that no longer exists as stopped', async () => {
    const { service, deps } = createHarness();
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    deps.abortSession.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'INVALID_SESSION' }));
    await expect(service.call('orch', 'session_stop', { sessionId: 'worker-1' })).resolves.toEqual({ sessionId: 'worker-1', stopped: ['worker-1'] });
  });

  it('rejects arguments outside the published contract before touching any session', async () => {
    const { service, deps } = createHarness();
    const invalid = [
      ['session_read', { sessionId: 'orch', limit: 0 }],
      ['session_read', { sessionId: 'orch', limit: 51 }],
      ['session_read', { sessionId: 'orch', limit: 1.5 }],
      ['session_wait', { sessionIds: [] }],
      ['session_wait', { sessionIds: Array.from({ length: 17 }, (_, index) => `s${index}`) }],
      ['session_wait', { sessionIds: ['orch'], timeoutMs: -1 }],
      ['session_wait', { sessionIds: ['orch'], timeoutMs: 3_600_001 }],
      ['session_send', { sessionId: 'orch', text: 'x', delivery: 'later' }],
      ['session_spawn', { cwd: '/work/a', task: 'x', extra: true }],
      ['session_spawn', { cwd: '/work/a' }],
    ];
    for (const [tool, args] of invalid) {
      await expectCode(service.call('orch', tool, args), 'INVALID_ARGUMENT');
    }
    expect(deps.activateSession).not.toHaveBeenCalled();
    expect(deps.createWorkerSession).not.toHaveBeenCalled();
  });

  it('refuses every tool to a caller session that no longer exists', async () => {
    const { service } = createHarness();
    for (const tool of ['session_read', 'session_send', 'session_interrupt']) {
      const args = tool === 'session_send' ? { sessionId: 'orch', text: 'x' } : { sessionId: 'orch' };
      await expectCode(service.call('deleted', tool, args), 'ORCHESTRATION_CALLER_GONE');
    }
    await expectCode(service.call('deleted', 'session_wait', { sessionIds: ['orch'] }), 'ORCHESTRATION_CALLER_GONE');
    await expect(service.call('orch', 'session_read', { sessionId: 'orch' })).resolves.toMatchObject({ sessionId: 'orch' });
  });

  it('retries a result delivery to an unreachable parent and reports a final failure', async () => {
    const { service, deps, orchestrator, runtimes, settle } = createHarness({
      // The parent becomes reachable again while the first retry waits.
      delay: async () => { runtimes.set('orch', orchestrator); },
    });
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    runtimes.delete('orch');
    deps.activateSession.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'RUNTIME_UNAVAILABLE' }));
    await settle('worker-1', 'result');
    expect(orchestrator.delivered).toHaveLength(1);
    expect(deps.delay).toHaveBeenCalledTimes(1);
    expect(deps.onDeliveryFailed).not.toHaveBeenCalled();

    deps.delay.mockImplementation(async () => {});
    orchestrator.session.sendCustomMessage = async () => { throw Object.assign(new Error('closed'), { code: 'RUNTIME_DISPOSED' }); };
    await settle('worker-1', 'second');
    expect(deps.delay).toHaveBeenCalledTimes(4);
    expect(deps.onDeliveryFailed).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'worker-1', parentSessionId: 'orch' }));
  });

  it('holds the parent guard for each delivery until it is accepted, but not across the backoff', async () => {
    const held = new Map();
    const heldDuring = { sends: [], backoffs: [] };
    const { service, deps, orchestrator, settle } = createHarness({
      delay: async () => { heldDuring.backoffs.push(held.get('orch') ?? 0); },
      holdSession: (sessionId) => {
        held.set(sessionId, (held.get(sessionId) ?? 0) + 1);
        return () => held.set(sessionId, held.get(sessionId) - 1);
      },
    });
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    const send = orchestrator.session.sendCustomMessage;
    orchestrator.session.sendCustomMessage = async (...args) => {
      heldDuring.sends.push(held.get('orch') ?? 0);
      if (heldDuring.sends.length === 1) throw Object.assign(new Error('closed'), { code: 'RUNTIME_DISPOSED' });
      return send.apply(orchestrator.session, args);
    };
    await settle('worker-1', 'result');
    expect(heldDuring).toEqual({ sends: [1, 1], backoffs: [0] });
    expect(held.get('orch')).toBe(0);
    expect(deps.onDeliveryFailed).not.toHaveBeenCalled();
  });

  it('holds the guard of every session a tool activates or aborts, including the old owner of a takeover', async () => {
    const held = new Map();
    const seen = [];
    const harness = createHarness({
      holdSession: (sessionId) => {
        held.set(sessionId, (held.get(sessionId) ?? 0) + 1);
        return () => held.set(sessionId, held.get(sessionId) - 1);
      },
    });
    const { service, deps, runtimes } = harness;
    const activate = deps.activateSession.getMockImplementation();
    deps.activateSession.mockImplementation(async (sessionId, ...rest) => {
      seen.push(['activate', sessionId, held.get(sessionId) ?? 0]);
      return activate(sessionId, ...rest);
    });
    const abort = deps.abortSession.getMockImplementation();
    deps.abortSession.mockImplementation(async (sessionId) => {
      seen.push(['abort', sessionId, held.get(sessionId) ?? 0]);
      return abort(sessionId);
    });
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await service.call('orch', 'session_interrupt', { sessionId: 'worker-1' });
    await expectCode(service.call('orch', 'session_read', { sessionId: 'gone' }), 'SESSION_NOT_FOUND');
    harness.add(createRuntime({ sessionId: 'orch-2' }));
    runtimes.delete('orch');
    await service.call('orch-2', 'orchestration_takeover', { fromSessionId: 'orch' });
    await service.call('orch-2', 'session_stop', { sessionId: 'worker-1' });
    expect(seen).toEqual([
      ['abort', 'worker-1', 1],
      ['activate', 'gone', 1],
      ['activate', 'orch', 1],
      ['abort', 'worker-1', 1],
    ]);
    expect([...held.values()].every((count) => count === 0)).toBe(true);
  });

  it('drops the result of a worker whose parent was deleted', async () => {
    const { service, deps, runtimes, settle } = createHarness();
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    runtimes.delete('orch');
    await settle('worker-1', 'result');
    expect(deps.delay).not.toHaveBeenCalled();
    expect(deps.onDeliveryFailed).not.toHaveBeenCalled();
  });

  it.each(['stop', 'takeover'])('takes the recipient of a result retry from the registry (%s while the retry waits)', async (change) => {
    const waiting = deferred();
    const backoff = deferred();
    const harness = createHarness({ delay: async () => { waiting.resolve(); await backoff.promise; } });
    const successor = harness.add(createRuntime({ sessionId: 'orch-2' }));
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    harness.runtimes.delete('orch');
    harness.deps.activateSession.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'RUNTIME_UNAVAILABLE' }));
    const settling = harness.settle('worker-1', 'the result');
    await waiting.promise;
    harness.runtimes.set('orch', harness.orchestrator);
    if (change === 'stop') await harness.service.call('orch', 'session_stop', { sessionId: 'worker-1' });
    else await harness.service.call('orch-2', 'orchestration_takeover', { fromSessionId: 'orch' });
    backoff.resolve();
    await settling;
    expect(harness.orchestrator.delivered).toHaveLength(0);
    expect(successor.delivered.map((entry) => entry.message.content))
      .toEqual(change === 'stop' ? [] : [expect.stringContaining('the result')]);
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

describe('orchestration review fixes (#125)', () => {
  it('holds the directory lock across daemons and against a prompt to a done worker', async () => {
    const first = createHarness();
    await first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    const second = createHarness({ file: first.file, workerPrefix: 'other' });
    await expectCode(second.service.call('orch', 'session_spawn', { cwd: '/work/a/.', task: 'two' }), 'ORCHESTRATION_CWD_BUSY');

    await finishWorker(first, 'worker-1');
    await first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'three' });
    await expectCode(first.input('worker-1'), 'ORCHESTRATION_CWD_BUSY');
    expect((await first.workers())['worker-1'].state).toBe('done');
  });

  it.each([['first', 'second'], ['second', 'first']])('returns the slot when two parallel inputs to a done worker start no run (%s ends first)', async (...order) => {
    const harness = createHarness({ workerLimit: 1 });
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await finishWorker(harness, 'worker-1');
    const tickets = {
      first: await harness.service.beforeSessionInput('worker-1'),
      second: await harness.service.beforeSessionInput('worker-1'),
    };
    expect((await harness.workers())['worker-1'].state).toBe('active');
    for (const name of order) await harness.service.afterSessionInput('worker-1', tickets[name], { startedRun: false });
    expect((await harness.workers())['worker-1'].state).toBe('done');
    await expect(harness.service.call('orch', 'orchestration_capabilities')).resolves.toMatchObject({ freeSlots: 1 });
  });

  it('keeps the slot when one of two parallel inputs started a run', async () => {
    const harness = createHarness({ workerLimit: 1 });
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await finishWorker(harness, 'worker-1');
    const first = await harness.service.beforeSessionInput('worker-1');
    const second = await harness.service.beforeSessionInput('worker-1');
    await harness.service.afterSessionInput('worker-1', first, { startedRun: true });
    await harness.service.afterSessionInput('worker-1', second, { startedRun: false });
    expect((await harness.workers())['worker-1'].state).toBe('active');
  });

  it('recovers the start of a daemon that died after this one first used the registry', async () => {
    const first = createHarness({ workerLimit: 1 });
    const hang = deferred();
    first.deps.createWorkerSession.mockImplementationOnce(() => hang.promise);
    void first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' }).catch(() => {});
    await vi.waitFor(() => expect(first.deps.createWorkerSession).toHaveBeenCalled());

    const second = createHarness({ workerLimit: 1, file: first.file });
    await expect(second.service.call('orch', 'orchestration_capabilities')).resolves.toMatchObject({ freeSlots: 0 });
    first.crash();
    await expect(second.service.call('orch', 'orchestration_capabilities')).resolves.toMatchObject({ freeSlots: 1 });
  });

  it('tells a reused pid from the daemon that recorded it by its start time', async () => {
    const first = createHarness({ startTime: 1 });
    const hang = deferred();
    first.deps.createWorkerSession.mockImplementationOnce(() => hang.promise);
    void first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' }).catch(() => {});
    await vi.waitFor(() => expect(first.deps.createWorkerSession).toHaveBeenCalled());
    const opId = (await first.registry.read()).requestKeys['orch:job-1'];

    // The same pid still running the same process: its start stays.
    const peer = createHarness({ file: first.file });
    await peer.service.call('orch', 'orchestration_capabilities');
    expect((await peer.registry.read()).operations[opId].state).toBe('reserved');

    // The daemon died and a new one got its pid: the start is recovered.
    const restarted = createHarness({ file: first.file, pid: first.deps.processId, startTime: 2 });
    await restarted.service.call('orch', 'orchestration_capabilities');
    expect((await restarted.registry.read()).operations[opId].state).toBe('abandoned');
  });

  it('does not send the task again when a crash followed its acceptance', async () => {
    const first = createHarness();
    first.deps.sendInput.mockImplementationOnce(async ({ sessionId, text }) => {
      first.runtimes.get(sessionId).session.messages.push({ role: 'user', content: [{ type: 'text', text }] });
      return new Promise(() => {});
    });
    void first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' });
    await vi.waitFor(() => expect(first.deps.sendInput).toHaveBeenCalled());
    const worker = first.runtimes.get('worker-1');

    // Pi persisted the transcript with the task; the journal never saw the acceptance.
    first.crash();
    const restarted = createHarness({ file: first.file, workerPrefix: 'after' });
    restarted.add(worker);
    restarted.fileStates.set('worker-1', 'present');
    await expect(restarted.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' }))
      .resolves.toMatchObject({ sessionId: 'worker-1' });
    expect(restarted.deps.sendInput).not.toHaveBeenCalled();
    expect(restarted.deps.createWorkerSession).not.toHaveBeenCalled();
  });

  it('keeps a start undecided when the session lookup fails', async () => {
    const first = createHarness();
    const hang = deferred();
    first.deps.createWorkerSession.mockImplementationOnce(() => hang.promise);
    void first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' }).catch(() => {});
    await vi.waitFor(() => expect(first.deps.createWorkerSession).toHaveBeenCalled());
    first.crash();
    const restarted = createHarness({ file: first.file });
    restarted.deps.findSessionByOperation.mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));
    await restarted.service.call('orch', 'orchestration_capabilities');
    const opId = (await restarted.registry.read()).requestKeys['orch:job-1'];
    expect((await restarted.registry.read()).operations[opId].state).toBe('reserved');
  });

  it('keeps a resumed start open instead of sending again when the transcript cannot be checked', async () => {
    const first = createHarness();
    first.deps.sendInput.mockImplementationOnce(async ({ sessionId, text }) => {
      first.runtimes.get(sessionId).session.messages.push({ role: 'user', content: [{ type: 'text', text }] });
      return new Promise(() => {});
    });
    void first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' });
    await vi.waitFor(() => expect(first.deps.sendInput).toHaveBeenCalled());
    const worker = first.runtimes.get('worker-1');

    first.crash();
    const restarted = createHarness({ file: first.file, workerPrefix: 'after' });
    restarted.fileStates.set('worker-1', 'present');
    // The worker is briefly resident elsewhere; the next check would succeed.
    restarted.deps.activateSession.mockRejectedValueOnce(Object.assign(new Error('in use'), { code: 'SESSION_IN_USE' }));
    await expectCode(restarted.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' }), 'ORCHESTRATION_START_UNDECIDED');
    restarted.add(worker);
    await expect(restarted.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' }))
      .resolves.toMatchObject({ sessionId: 'worker-1' });
    expect(restarted.deps.sendInput).not.toHaveBeenCalled();
    expect(restarted.deps.createWorkerSession).not.toHaveBeenCalled();
  });

  it('sends the task of a resumed start when the transcript holds only another user message', async () => {
    const first = createHarness();
    first.deps.sendInput.mockImplementationOnce(async ({ sessionId }) => {
      first.runtimes.get(sessionId).session.messages.push({ role: 'user', content: 'a different prompt' });
      return new Promise(() => {});
    });
    void first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' });
    await vi.waitFor(() => expect(first.deps.sendInput).toHaveBeenCalled());
    const worker = first.runtimes.get('worker-1');

    first.crash();
    const restarted = createHarness({ file: first.file, workerPrefix: 'after' });
    restarted.add(worker);
    restarted.fileStates.set('worker-1', 'present');
    await expect(restarted.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' }))
      .resolves.toMatchObject({ sessionId: 'worker-1' });
    expect(restarted.deps.sendInput).toHaveBeenCalledTimes(1);
    expect(restarted.deps.sendInput.mock.calls[0][0].text).toBe(first.deps.sendInput.mock.calls[0][0].text);
  });

  it('holds a start whose session file has an unreadable lineage entry and adopts the session once it is readable', async () => {
    const first = createHarness();
    const hang = deferred();
    first.deps.createWorkerSession.mockImplementationOnce(() => hang.promise);
    void first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' }).catch(() => {});
    await vi.waitFor(() => expect(first.deps.createWorkerSession).toHaveBeenCalled());
    const opId = (await first.registry.read()).requestKeys['orch:job-1'];
    const path = join(mkdtempSync(join(tmpdir(), 'pichamber-orchestration-jsonl-')), 'persisted-1.jsonl');
    const lineage = JSON.stringify({ type: 'custom', customType: LINEAGE_ENTRY, data: { parentSessionId: 'orch', opId } });
    const header = JSON.stringify({ type: 'session', id: 'persisted-1' });
    const user = JSON.stringify({ type: 'message', message: { role: 'user', content: 'hello' } });
    writeFileSync(path, `${header}\n${lineage.slice(0, -8)}\n${user}\n`);

    first.crash();
    const restarted = createHarness({ file: first.file });
    restarted.deps.findSessionByOperation.mockImplementation(({ opId: wanted, cwd }) => findPersistedSessionByOperation({
      opId: wanted,
      cwd,
      listSessions: async () => [{ id: 'persisted-1', path }],
      lineageType: LINEAGE_ENTRY,
    }));
    await restarted.service.call('orch', 'orchestration_capabilities');
    expect((await restarted.registry.read()).operations[opId].state).toBe('reserved');
    await expectCode(restarted.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' }), 'SESSION_LOOKUP_FAILED');
    expect(restarted.deps.createWorkerSession).not.toHaveBeenCalled();

    writeFileSync(path, `${header}\n${lineage}\n${user}\n`);
    restarted.add(createRuntime({ sessionId: 'persisted-1', cwd: '/work/a', lineage: { parentSessionId: 'orch', opId } }));
    await expect(restarted.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' }))
      .resolves.toMatchObject({ sessionId: 'persisted-1' });
    expect(restarted.deps.createWorkerSession).not.toHaveBeenCalled();
    expect(restarted.deps.sendInput).toHaveBeenCalledTimes(1);
  });

  it('does not release a reserved start another process claimed while the check ran', async () => {
    const first = createHarness({ workerLimit: 1 });
    const hang = deferred();
    first.deps.createWorkerSession.mockImplementationOnce(() => hang.promise);
    void first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' }).catch(() => {});
    await vi.waitFor(() => expect(first.deps.createWorkerSession).toHaveBeenCalled());
    first.crash();

    const checker = createHarness({ workerLimit: 1, file: first.file });
    const lookup = deferred();
    checker.deps.findSessionByOperation.mockImplementationOnce(async () => { await lookup.promise; return undefined; });
    const checking = checker.service.call('orch', 'orchestration_capabilities');
    await vi.waitFor(() => expect(checker.deps.findSessionByOperation).toHaveBeenCalled());
    const opId = (await checker.registry.read()).requestKeys['orch:job-1'];
    const claimant = createHarness({ file: first.file });
    await checker.registry.update((document) => { document.operations[opId].process = { pid: claimant.deps.processId, instance: 'claimant' }; });
    lookup.resolve();
    await checking;

    expect((await checker.registry.read()).operations[opId].state).toBe('reserved');
    await expectCode(checker.service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');
  });

  it('does not apply an old file check to a start another process claimed meanwhile', async () => {
    const first = createHarness();
    await first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    first.crash();

    const checker = createHarness({ file: first.file });
    const check = deferred();
    checker.deps.sessionFileState.mockImplementationOnce(async () => { await check.promise; return 'absent'; });
    const checking = checker.service.call('orch', 'orchestration_capabilities');
    await vi.waitFor(() => expect(checker.deps.sessionFileState).toHaveBeenCalled());
    const claimant = createHarness({ file: first.file });
    await checker.registry.update((document) => { document.workers['worker-1'].process = { pid: claimant.deps.processId, instance: 'claimant' }; });
    check.resolve();
    await checking;

    expect((await checker.workers())['worker-1']).toMatchObject({ state: 'starting' });
  });

  it('lets prompts to ordinary sessions through a broken registry, and keeps workers and tools closed', async () => {
    const harness = createHarness();
    writeFileSync(harness.file, 'not json');
    harness.add(createRuntime({ sessionId: 'worker-x', cwd: '/work/x', lineage: { parentSessionId: 'orch', parentDirectory: '/work/main', role: 'task-hard', opId: 'op_x' } }));
    const ticket = await harness.service.beforeSessionInput('orch');
    await harness.service.afterSessionInput('orch', ticket, { startedRun: true });
    await expect(harness.service.beforeSessionInput('worker-x')).rejects.toThrow();
    await expect(harness.service.call('orch', 'orchestration_capabilities')).rejects.toThrow();
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

  it('refuses a takeover while a start step of the old orchestrator runs in another live process', async () => {
    const old = createHarness();
    const hang = deferred();
    old.deps.createWorkerSession.mockImplementationOnce(async (options) => {
      await hang.promise;
      return { sessionId: 'late-session', cwd: options.cwd };
    });
    const running = old.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' }).catch((error) => error);
    await vi.waitFor(() => expect(old.deps.createWorkerSession).toHaveBeenCalled());

    const successor = createHarness({ file: old.file, workerPrefix: 'new' });
    successor.add(createRuntime({ sessionId: 'orch-2' }));
    successor.add(createRuntime({ sessionId: 'orch' }));
    await expectCode(successor.service.call('orch-2', 'orchestration_takeover', { fromSessionId: 'orch' }), 'ORCHESTRATION_TAKEOVER_BUSY');
    hang.resolve();
    await running;
    expect(Object.values((await successor.registry.read()).operations)[0].orchestratorSessionId).toBe('orch');
  });

  it('refuses a takeover of an orchestrator resident in another daemon', async () => {
    const harness = createHarness();
    harness.add(createRuntime({ sessionId: 'orch-2' }));
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    harness.runtimes.delete('orch');
    harness.deps.activateSession.mockImplementation(async (sessionId) => {
      if (sessionId === 'orch') throw Object.assign(new Error('in use'), { code: 'SESSION_IN_USE' });
      return harness.runtimes.get(sessionId);
    });
    await expectCode(harness.service.call('orch-2', 'orchestration_takeover', { fromSessionId: 'orch' }), 'ORCHESTRATION_TAKEOVER_BUSY');
    expect((await harness.workers())['worker-1'].orchestratorSessionId).toBe('orch');
  });

  it('lets the new owner finish the partial start of a dead process once and refuses a late write of the old call', async () => {
    const old = createHarness();
    const hang = deferred();
    old.deps.createWorkerSession.mockImplementationOnce(async (options) => {
      await hang.promise;
      return { sessionId: 'late-session', cwd: options.cwd };
    });
    const lateCall = old.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' });
    await vi.waitFor(() => expect(old.deps.createWorkerSession).toHaveBeenCalled());

    // The old process counts as dead (its pid was reused, for example), but
    // its call still finishes: the registry must fence that late write.
    old.crash();
    const successor = createHarness({ file: old.file, workerPrefix: 'new' });
    successor.add(createRuntime({ sessionId: 'orch-2' }));
    successor.add(createRuntime({ sessionId: 'orch' }));
    const moved = await successor.service.call('orch-2', 'orchestration_takeover', { fromSessionId: 'orch' });
    await expect(successor.service.call('orch-2', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' }))
      .resolves.toMatchObject({ sessionId: 'new-1' });

    hang.resolve();
    const late = await lateCall.catch((error) => error);
    const document = await successor.registry.read();
    // The dead start was closed before the takeover; the late write cannot revive it.
    expect(moved).toMatchObject({ workers: [], operations: [] });
    expect(late?.code).toBe('ORCHESTRATION_START_CLOSED');
    expect(Object.values(document.operations).map((operation) => [operation.state, operation.orchestratorSessionId]))
      .toEqual([['abandoned', 'orch'], ['created', 'orch-2']]);
    expect(Object.keys(document.workers)).toEqual(['new-1']);
    expect(document.workers['new-1'].orchestratorSessionId).toBe('orch-2');
  });

  it('fences a stop that was authorized before a takeover', async () => {
    const harness = createHarness();
    harness.add(createRuntime({ sessionId: 'orch-2' }));
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await harness.settle('worker-1', 'idle now');
    // Hold the old stop between its policy check and its claim.
    const reached = deferred();
    const release = deferred();
    const update = harness.registry.update.bind(harness.registry);
    let held = false;
    vi.spyOn(harness.registry, 'update').mockImplementation(async (change) => {
      if (!held) {
        const probe = structuredClone(await harness.registry.read());
        try { change(probe); } catch { /* the probe only looks for the claim */ }
        if (probe.workers['worker-1']?.stopping) {
          held = true;
          reached.resolve();
          await release.promise;
        }
      }
      return update(change);
    });
    const stopping = harness.service.call('orch', 'session_stop', { sessionId: 'worker-1' });
    await reached.promise;
    await harness.service.call('orch-2', 'orchestration_takeover', { fromSessionId: 'orch' });
    release.resolve();
    await expectCode(stopping, 'ORCHESTRATION_OWNER_CHANGED');
    expect(harness.deps.abortSession).not.toHaveBeenCalled();
    const worker = (await harness.workers())['worker-1'];
    expect(worker).toMatchObject({ orchestratorSessionId: 'orch-2' });
    expect(worker.state).not.toBe('stopped');
    expect(worker.stopping).toBeUndefined();
  });

  it('refuses a takeover while a stop of the old orchestrator is aborting', async () => {
    const harness = createHarness();
    harness.add(createRuntime({ sessionId: 'orch-2' }));
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await harness.settle('worker-1', 'idle now');
    const abort = deferred();
    harness.deps.abortSession.mockImplementationOnce(() => abort.promise);
    const stopping = harness.service.call('orch', 'session_stop', { sessionId: 'worker-1' });
    await vi.waitFor(() => expect(harness.deps.abortSession).toHaveBeenCalled());
    await expectCode(harness.service.call('orch-2', 'orchestration_takeover', { fromSessionId: 'orch' }), 'ORCHESTRATION_TAKEOVER_BUSY');
    abort.resolve();
    await expect(stopping).resolves.toMatchObject({ stopped: ['worker-1'] });
    expect((await harness.workers())['worker-1']).toMatchObject({ orchestratorSessionId: 'orch', state: 'stopped' });
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
