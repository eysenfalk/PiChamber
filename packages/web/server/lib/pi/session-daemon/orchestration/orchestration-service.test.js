import { describe, expect, it, vi } from 'vitest';

import { ORCHESTRATION_TOOLS } from './tool-contracts.js';
import { SUPPORTED_KEYWORDS } from './contract-validator.js';
import {
  CHILD_ENTRY,
  LINEAGE_ENTRY,
  RESULT_MESSAGE,
  childRecordsOf,
  createOrchestrationService,
} from './orchestration-service.js';

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

const createHarness = ({ workerLimit = 4, activity = new Map(), now, delay = async () => {} } = {}) => {
  const runtimes = new Map();
  const states = new Map();
  const add = (runtime) => { runtimes.set(runtime.session.sessionId, runtime); return runtime; };
  const orchestrator = add(createRuntime({ sessionId: 'orch' }));
  let counter = 0;
  const deps = {
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
      const runtime = add(createRuntime({ sessionId: `worker-${counter}`, cwd, lineage }));
      return { sessionId: runtime.session.sessionId, cwd };
    }),
    sendInput: vi.fn(async ({ sessionId }) => { states.set(sessionId, 'busy'); return { accepted: true }; }),
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
    onDeliveryFailed: vi.fn(),
    delay: vi.fn(delay),
    now,
  };
  const service = createOrchestrationService(deps);
  const settle = async (sessionId, assistant) => {
    const runtime = runtimes.get(sessionId);
    if (assistant) runtime.session.messages.push({ role: 'assistant', content: [{ type: 'text', text: assistant }] });
    states.set(sessionId, 'idle');
    await service.onSessionSettled(sessionId, runtime);
  };
  return { service, deps, runtimes, states, orchestrator, settle };
};

const expectCode = async (promise, code) => {
  await expect(promise).rejects.toMatchObject({ code });
};

describe('orchestration tool contracts', () => {
  it('offers exactly the owner\'s eleven roles to session_spawn', () => {
    const spawn = ORCHESTRATION_TOOLS.find((tool) => tool.name === 'session_spawn');
    expect(spawn.parameters.properties.role.enum).toEqual([
      'orchestrate', 'plan', 'oracle', 'debug', 'task-easy', 'task-medium', 'task-hard', 'task-extreme', 'research', 'small', 'review',
    ]);
  });
});

describe('orchestration contract validation', () => {
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
  it('spawns a linked worker, starts its task and reports it as a slot', async () => {
    const { service, deps, orchestrator, runtimes } = createHarness();
    const spawned = await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'Fix the bug\nDetails', role: 'task-hard' });

    expect(spawned).toMatchObject({ sessionId: 'worker-1', cwd: '/work/a', title: 'Fix the bug', role: 'task-hard', state: 'busy' });
    expect(spawned.model).toEqual({ providerId: 'anthropic', modelId: 'claude-opus-5-5' });
    expect(deps.createWorkerSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/work/a',
      thinking: 'high',
      parentSessionPath: '/sessions/orch.jsonl',
      lineage: { parentSessionId: 'orch', parentDirectory: '/work/main', role: 'task-hard' },
    }));
    expect(deps.sendInput).toHaveBeenCalledWith({ sessionId: 'worker-1', text: 'Fix the bug\nDetails', delivery: 'prompt', operationId: undefined });
    expect(childRecordsOf(orchestrator).map((record) => record.sessionId)).toEqual(['worker-1']);
    expect(service.isWorker(runtimes.get('worker-1').session.sessionManager)).toBe(true);
    expect(service.isWorker(orchestrator.session.sessionManager)).toBe(false);

    const capabilities = await service.call('orch', 'orchestration_capabilities');
    expect(capabilities).toMatchObject({ workerLimit: 4, freeSlots: 3, canSpawn: true, host: { cpuCount: 8 } });
    expect(capabilities.workers).toEqual([expect.objectContaining({ sessionId: 'worker-1', branch: 'main', state: 'busy' })]);
  });

  it('enforces the worker limit until a worker is stopped', async () => {
    const { service } = createHarness({ workerLimit: 1 });
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');

    await service.call('orch', 'session_stop', { sessionId: 'worker-1' });
    await expect(service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' })).resolves.toMatchObject({ sessionId: 'worker-2' });
  });

  it('rejects a second worker in a directory where a managed worker is busy', async () => {
    const { service } = createHarness();
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'two' }), 'ORCHESTRATION_CWD_BUSY');
  });

  it('keeps spawn and stop away from workers and foreign sessions', async () => {
    const { service, runtimes } = createHarness();
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await expectCode(service.call('worker-1', 'session_spawn', { cwd: '/work/b', task: 'x' }), 'ORCHESTRATION_FORBIDDEN');
    await expectCode(service.call('worker-1', 'session_stop', { sessionId: 'orch' }), 'ORCHESTRATION_FORBIDDEN');

    runtimes.set('other', createRuntime({ sessionId: 'other' }));
    await expectCode(service.call('orch', 'session_stop', { sessionId: 'other' }), 'ORCHESTRATION_FORBIDDEN');
    // Foreign sessions stay readable, steerable and interruptible.
    await expect(service.call('orch', 'session_send', { sessionId: 'other', text: 'hi', delivery: 'steer' })).resolves.toMatchObject({ accepted: true });
    await expect(service.call('orch', 'session_interrupt', { sessionId: 'other' })).resolves.toEqual({ sessionId: 'other', interrupted: true });
    await expect(service.call('orch', 'session_read', { sessionId: 'other' })).resolves.toMatchObject({ sessionId: 'other', cwd: '/work/main' });
  });

  it('deduplicates retried and concurrent spawns by clientRequestId', async () => {
    const { service, deps } = createHarness();
    const args = { cwd: '/work/a', task: 'one', clientRequestId: 'req-1' };
    const [first, concurrent] = await Promise.all([
      service.call('orch', 'session_spawn', args),
      service.call('orch', 'session_spawn', args),
    ]);
    const retried = await service.call('orch', 'session_spawn', args);

    expect(deps.createWorkerSession).toHaveBeenCalledTimes(1);
    expect(concurrent).toMatchObject({ sessionId: first.sessionId, deduplicated: true });
    expect(retried).toMatchObject({ sessionId: first.sessionId, deduplicated: true });
    expect(deps.sendInput).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'req-1.task' }));
  });

  it('resolves waits when a worker settles and reports timeouts otherwise', async () => {
    const { service, settle } = createHarness();
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });

    await expect(service.call('orch', 'session_wait', { sessionIds: ['worker-1'], timeoutMs: 10 }))
      .resolves.toMatchObject({ timedOut: true, sessions: [{ sessionId: 'worker-1', state: 'busy' }] });

    const waiting = service.call('orch', 'session_wait', { sessionIds: ['worker-1'], timeoutMs: 5_000 });
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

  it('delivers a settled worker result to its parent as a turn-starting custom message', async () => {
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

  it('stops a worker tree without delivering the stopped results', async () => {
    const { service, deps, orchestrator, runtimes, settle } = createHarness();
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    // A grandchild recorded under worker-1 (e.g. spawned before a role change).
    runtimes.get('worker-1').session.sessionManager.appendCustomEntry(CHILD_ENTRY, { sessionId: 'grand', cwd: '/work/g' });
    runtimes.set('grand', createRuntime({ sessionId: 'grand', cwd: '/work/g', lineage: { parentSessionId: 'worker-1' } }));

    const stopped = await service.call('orch', 'session_stop', { sessionId: 'worker-1' });
    expect(stopped.stopped).toEqual(['grand', 'worker-1']);
    expect(deps.abortSession).toHaveBeenCalledWith('worker-1');
    expect(deps.abortSession).toHaveBeenCalledWith('grand');

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
    const { service, deps, orchestrator } = createHarness({ workerLimit: 1 });
    deps.sendInput.mockRejectedValueOnce(Object.assign(new Error('no auth'), { code: 'PROVIDER_AUTH_REQUIRED' }));
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job' }), 'PROVIDER_AUTH_REQUIRED');
    await expect(service.call('orch', 'orchestration_capabilities')).resolves.toMatchObject({ freeSlots: 1, workers: [] });

    const retried = await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job' });
    expect(retried).toMatchObject({ sessionId: 'worker-2', state: 'busy' });
    expect(retried.deduplicated).toBeUndefined();
    expect(deps.sendInput).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'worker-2', operationId: 'job.task' }));
    expect(childRecordsOf(orchestrator).map(({ sessionId, stopped, rejected }) => ({ sessionId, stopped, rejected })))
      .toEqual([{ sessionId: 'worker-1', stopped: true, rejected: true }, { sessionId: 'worker-2', stopped: false, rejected: undefined }]);
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

  it('drops the result of a worker whose parent was deleted', async () => {
    const { service, deps, runtimes, settle } = createHarness();
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    runtimes.delete('orch');
    await settle('worker-1', 'result');
    expect(deps.delay).not.toHaveBeenCalled();
    expect(deps.onDeliveryFailed).not.toHaveBeenCalled();
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
