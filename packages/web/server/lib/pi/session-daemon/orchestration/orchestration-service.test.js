import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { EVENTS_MESSAGE } from './wakes.js';
import { findPersistedSessionByOperation } from './session-lookup.js';
import { readGitBranch } from './host-info.js';
import { ORCHESTRATION_INSTRUCTIONS } from './instructions.js';

const ROLES = {
  'task-hard': { modelId: 'claude-opus-5-5', thinking: 'high' },
  research: { modelId: 'claude-sonnet-5-5', thinking: 'medium' },
  small: { modelId: 'claude-haiku-5-5', thinking: 'low' },
  review: { modelId: 'gpt-6.1-sol', thinking: 'high' },
};

const createRuntime = ({ sessionId, cwd = '/work/main', lineage } = {}) => {
  const entries = [];
  let leafId = null;
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
        getLeafId: () => leafId,
        setLeaf: (id) => { leafId = id; },
        appendCustomEntry: (customType, data) => { entries.push({ type: 'custom', customType, data }); },
        getSessionName: () => `title ${sessionId}`,
        getSessionId: () => sessionId,
      },
      sendCustomMessage: async (message, options) => { runtime.delivered.push({ message, options }); },
      getSessionStats: () => runtime.stats,
    },
  };
  if (lineage) runtime.session.sessionManager.appendCustomEntry(LINEAGE_ENTRY, lineage);
  return runtime;
};

// The sessions these tests use as orchestrators carry the mark.
const MARKED = ['orch', 'orch-2', 'other', 'owner-session', 'legacy', 'other-orch'];

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
const GIB = 1024 ** 3;

/**
 * One daemon process. Two harnesses on the same `file` are two processes
 * sharing the durable registry; a new harness on the same file is a restart.
 */
const createHarness = ({ workerLimit = 4, activity = new Map(), now, file = registryFile(), workerPrefix = 'worker', delay = async () => {}, pid: reusedPid, startTime, holdSession, gate = { enabled: true, minAvailableBytes: 8 * GIB }, orchestrators = MARKED, overrides = {} } = {}) => {
  // Mutable, so a test can make the host busy between calls.
  const host = { cpuCount: 8, loadAverage: { '1m': 1 }, memory: { freeBytes: 16 * GIB } };
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
  // The daemon's one input path: a fast check, the admission under the
  // session lease right before the prompt, and Pi's verdict on the prompt.
  const input = async (sessionId, { outcome = 'started', beforeStart, beforeVerdict, run, finished, source } = {}) => {
    await service.beforeSessionInput(sessionId);
    // The daemon's activation and lease lie between the check and the admission.
    await beforeStart?.();
    const ticket = await service.admitInput(sessionId, source);
    // Pi's own awaits (extension commands, input handlers) lie between the
    // admission and its verdict.
    await beforeVerdict?.();
    if (outcome === 'rejected') {
      await service.resolveInput(ticket, 'rejected');
      throw Object.assign(new Error('rejected by preflight'), { code: 'PROMPT_REJECTED' });
    }
    if (outcome === 'started') states.set(sessionId, 'busy');
    await verdict(ticket, outcome, { run, finished });
    return { accepted: true, ticket };
  };
  // Prompts whose run this process started, per worker, until their end is
  // proven. A started verdict gets a bound signal and its prompt's end as
  // `finished` (the daemon's `provenRunEnd`); `finished: null` is a late
  // verdict of a deferred prompt, which has no such proof, and `run: null`
  // a prompt that started no run of its own.
  const prompts = new Map();
  const verdict = async (ticket, outcome, { run, finished } = {}) => {
    if (outcome !== 'started' || !ticket) return service.resolveInput(ticket, outcome);
    let end;
    const ended = finished === null ? undefined : (finished ?? new Promise((resolve) => { end = resolve; }));
    const handle = run === undefined ? Promise.resolve({ signal: ticket.token }) : run;
    const resolved = await service.resolveInput(ticket, 'started', { run: handle, finished: ended });
    if (end) {
      const list = prompts.get(ticket.sessionId) ?? [];
      list.push({ end, completion: resolved?.completion });
      prompts.set(ticket.sessionId, list);
    }
    return resolved;
  };
  // The prompts of a worker end: each proves its run's end (or not).
  const endPrompts = async (sessionId, proven = true) => {
    const list = prompts.get(sessionId) ?? [];
    prompts.delete(sessionId);
    for (const prompt of list) prompt.end(proven);
    await Promise.all(list.map((prompt) => prompt.completion));
  };
  const deps = {
    registry,
    navigateSession: vi.fn(async (sessionId, entryId) => {
      const manager = runtimes.get(sessionId).session.sessionManager;
      if (!manager.getEntries().some((entry) => entry.id === entryId)) throw new Error(`Entry ${entryId} not found`);
      const previousLeafId = manager.getLeafId();
      manager.setLeaf(entryId);
      return { targetEntryId: entryId, previousLeafId, newLeafId: entryId };
    }),
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
    // The orchestration service's own sends (spawn task, session_send) are the orchestrator's writes.
    sendInput: vi.fn(async ({ sessionId, source = 'orchestrator' }) => input(sessionId, { source })),
    abortSession: vi.fn(async (sessionId) => { states.set(sessionId, 'idle'); }),
    abortRun: vi.fn(() => true),
    readSettings: async () => ({ workerLimit, gate, roles: ROLES, wakes: { coalesceMs: 0 }, orchestrators }),
    listModels: async () => [
      { providerId: 'anthropic', modelId: 'claude-opus-5-5', available: true },
      { providerId: 'anthropic', modelId: 'claude-sonnet-5-5', available: true },
      { providerId: 'openai-codex', modelId: 'gpt-6.1-sol', available: true },
    ],
    hostStatus: () => host,
    resolveBranch: async () => 'main',
    resolveRepository: async () => 'acme/app',
    getSessionActivity: (sessionId) => activity.get(sessionId),
    sessionFileState: vi.fn(async (sessionId) => fileStates.get(sessionId) ?? 'absent'),
    findSessionByOperation: vi.fn(async ({ opId, exclude = [] }) => {
      const runtime = [...runtimes.values()].find((candidate) => !exclude.includes(candidate.session.sessionId)
        && candidate.session.sessionManager.getEntries()
        .some((entry) => entry.customType === LINEAGE_ENTRY && entry.data?.opId === opId));
      return runtime ? { sessionId: runtime.session.sessionId, cwd: runtime.cwd, sessionFile: runtime.session.sessionFile } : undefined;
    }),
    now,
    canonicalDirectory: async (directory) => resolve(directory),
    onAdmissionUnresolved: vi.fn(),
    ...(holdSession ? { holdSession } : {}),
    processId: pid,
    processInstance: `process-${pid}-${nextInstance}`,
    processStartTime: (candidate) => startTimes.get(candidate) ?? null,
    isProcessAlive: (candidate) => alivePids.has(candidate),
    ...overrides,
  };
  service = createOrchestrationService(deps);
  // A run settles: Pi emits `agent_settled`, then the prompts that started
  // runs end (`ended: false` keeps them open).
  const settle = async (sessionId, assistant, { durable = true, ended = true } = {}) => {
    const runtime = runtimes.get(sessionId);
    if (assistant) runtime.session.messages.push({ role: 'assistant', content: [{ type: 'text', text: assistant }] });
    if (durable && !fileStates.has(sessionId)) fileStates.set(sessionId, 'present');
    states.set(sessionId, 'idle');
    await service.onSessionSettled(sessionId, runtime);
    if (ended) await endPrompts(sessionId);
  };
  const workers = async () => (await registry.read()).workers;
  // The process dies; its resident sessions die with it.
  const crash = () => { alivePids.delete(pid); };
  return { host, service, deps, runtimes, states, fileStates, orchestrator, settle, input, verdict, endPrompts, registry, workers, file, add, crash };
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
    expect(lineage).toEqual({
      parentSessionId: 'orch',
      parentDirectory: '/work/main',
      role: 'task-hard',
      opId: expect.stringMatching(/^op_/),
      profile: { name: 'full', excludeTools: [], excludeExtensions: [] },
    });
    const [{ text, operationId }] = deps.sendInput.mock.calls[0];
    expect(text).toMatch(/^You are a worker session started by the PiChamber orchestrator session orch\./);
    expect(text.endsWith('Fix the bug\nDetails')).toBe(true);
    expect(text).toContain('lab/run down');
    expect(text).toContain('report `blocked`');
    expect(operationId).toBe(`${lineage.opId}.task`);

    const document = await registry.read();
    expect(document.workers['worker-1']).toMatchObject({ orchestratorSessionId: 'orch', opId: lineage.opId, role: 'task-hard', state: 'starting' });
    expect(document.operations[lineage.opId]).toMatchObject({ state: 'created', sessionId: 'worker-1', step: 'prompted' });
    expect(Object.keys(document.operations[lineage.opId].steps)).toEqual(['reserved', 'session', 'prompted']);
    // The registry is the record; nothing is written into the orchestrator's JSONL.
    expect(orchestrator.session.sessionManager.getEntries()).toEqual([]);
    await expect(service.sessionKind(runtimes.get('worker-1').session.sessionManager)).resolves.toBe('worker');
    await expect(service.sessionKind(orchestrator.session.sessionManager)).resolves.toBe('orchestrator');

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

  it('gives the tools only to a session marked as orchestrator, and to workers', async () => {
    const orchestrators = ['orch'];
    const { service, deps, runtimes } = createHarness({ orchestrators });
    const plain = createRuntime({ sessionId: 'plain' });
    runtimes.set('plain', plain);
    await expect(service.sessionKind(plain.session.sessionManager)).resolves.toBe('unmarked');
    // MCP discovery (Adapter B) asks the same decision.
    await expect(service.verifyCaller('plain')).resolves.toEqual({ sessionId: 'plain', kind: 'unmarked' });
    await expectCode(service.call('plain', 'orchestration_capabilities'), 'ORCHESTRATION_FORBIDDEN');
    await expectCode(service.call('plain', 'session_spawn', { cwd: '/work/a', task: 'one' }), 'ORCHESTRATION_FORBIDDEN');
    expect(deps.createWorkerSession).not.toHaveBeenCalled();

    // The mark acts on the next call, and removing it takes the tools away again.
    orchestrators.push('plain');
    await expect(service.call('plain', 'orchestration_capabilities')).resolves.toMatchObject({ canSpawn: true });
    await expect(service.verifyCaller('plain')).resolves.toMatchObject({ kind: 'orchestrator' });
    await service.call('plain', 'session_spawn', { cwd: '/work/a', task: 'one' });
    orchestrators.pop();
    await expectCode(service.call('plain', 'session_list'), 'ORCHESTRATION_FORBIDDEN');

    // A marked worker stays a worker.
    orchestrators.push('worker-1');
    await expect(service.sessionKind(runtimes.get('worker-1').session.sessionManager)).resolves.toBe('worker');
    await expect(service.verifyCaller('worker-1')).resolves.toEqual({ sessionId: 'worker-1', kind: 'worker' });
    await expectCode(service.call('worker-1', 'session_spawn', { cwd: '/work/b', task: 'x' }), 'ORCHESTRATION_FORBIDDEN');
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

  it('never adopts the session a recreate replaced, also when the new create fails late', async () => {
    const first = createHarness();
    await first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' });
    first.crash();
    const restarted = createHarness({ file: first.file, workerPrefix: 'after' });
    await restarted.service.call('orch', 'orchestration_capabilities');
    const opId = (await restarted.registry.read()).requestKeys['orch:job-1'];
    expect((await restarted.registry.read()).operations[opId]).toMatchObject({ recreate: true, replaced: ['worker-1'] });

    // The replaced session turns up again with the same lineage, and the new
    // create fails after it may have made a session.
    restarted.add(createRuntime({ sessionId: 'worker-1', cwd: '/work/a', lineage: { parentSessionId: 'orch', opId } }));
    restarted.deps.createWorkerSession.mockRejectedValueOnce(Object.assign(new Error('late'), { code: 'CREATE_FAILED' }));
    await expectCode(restarted.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', clientRequestId: 'job-1' }), 'CREATE_FAILED');
    expect(restarted.deps.findSessionByOperation).toHaveBeenLastCalledWith(expect.objectContaining({ opId, exclude: ['worker-1'] }));
    expect(await restarted.workers()).toEqual({});
    expect(restarted.deps.sendInput).not.toHaveBeenCalled();
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

  describe('session_rewind', () => {
    const withEntries = async (harness) => {
      await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
      const manager = harness.runtimes.get('worker-1').session.sessionManager;
      const message = (id, role, text) => manager.getEntries().push({ type: 'message', id, message: { role, content: [{ type: 'text', text }] } });
      message('e1', 'user', 'first');
      message('e2', 'assistant', 'answer');
      message('e3', 'user', 'second');
      manager.setLeaf('e3');
      await harness.settle('worker-1');
      return manager;
    };

    it('lists the entry ids of the active branch in session_read', async () => {
      const harness = createHarness();
      await withEntries(harness);
      const read = await harness.service.call('orch', 'session_read', { sessionId: 'worker-1' });
      expect(read.messages).toEqual(expect.arrayContaining([
        { entryId: 'e1', role: 'user', text: 'first' },
        { entryId: 'e2', role: 'assistant', text: 'answer' },
      ]));
    });

    it('moves an idle worker back and keeps its session; a prompt runs it again', async () => {
      const harness = createHarness();
      const manager = await withEntries(harness);
      await expect(harness.service.call('orch', 'session_rewind', { sessionId: 'worker-1', entryId: 'e2' }))
        .resolves.toEqual({ sessionId: 'worker-1', previousLeafId: 'e3', newLeafId: 'e2', prompted: false });
      expect(manager.getLeafId()).toBe('e2');
      expect(harness.deps.sendInput).toHaveBeenCalledTimes(1);

      await expect(harness.service.call('orch', 'session_rewind', { sessionId: 'worker-1', entryId: 'e1', prompt: 'RUN AGAIN' }))
        .resolves.toMatchObject({ sessionId: 'worker-1', newLeafId: 'e1', prompted: true });
      expect(harness.deps.sendInput).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'worker-1', text: 'RUN AGAIN' }));
      expect(harness.states.get('worker-1')).toBe('busy');
    });

    it('refuses a worker that runs or waits for input, a foreign worker, a worker as caller and an unknown entry', async () => {
      const activity = new Map();
      const harness = createHarness({ activity });
      const manager = await withEntries(harness);

      await expectCode(harness.service.call('orch', 'session_rewind', { sessionId: 'worker-1', entryId: 'nope' }), 'SESSION_TREE_NOT_FOUND');
      await expectCode(harness.service.call('worker-1', 'session_rewind', { sessionId: 'worker-1', entryId: 'e1' }), 'ORCHESTRATION_FORBIDDEN');
      await expectCode(harness.service.call('orch', 'session_rewind', { sessionId: 'other', entryId: 'e1' }), 'ORCHESTRATION_FORBIDDEN');

      activity.set('worker-1', { waitingForInput: true });
      await expectCode(harness.service.call('orch', 'session_rewind', { sessionId: 'worker-1', entryId: 'e1' }), 'ORCHESTRATION_SESSION_BUSY');
      // A direct input that Pi has accepted but not yet turned into a run.
      activity.set('worker-1', { inputActive: true });
      await expectCode(harness.service.call('orch', 'session_rewind', { sessionId: 'worker-1', entryId: 'e1' }), 'ORCHESTRATION_SESSION_BUSY');
      activity.delete('worker-1');
      for (const state of ['busy', 'retry']) {
        harness.states.set('worker-1', state);
        await expectCode(harness.service.call('orch', 'session_rewind', { sessionId: 'worker-1', entryId: 'e1' }), 'ORCHESTRATION_SESSION_BUSY');
      }
      expect(manager.getLeafId()).toBe('e3');
      expect(harness.deps.navigateSession).not.toHaveBeenCalledWith('worker-1', 'e1');
    });
  });

  it('replays a repeated rewind by clientRequestId instead of moving the leaf again', async () => {
    const harness = createHarness();
    const manager = await (async () => {
      await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
      const m = harness.runtimes.get('worker-1').session.sessionManager;
      for (const [id, role] of [['e1', 'user'], ['e2', 'assistant'], ['e3', 'user']]) m.getEntries().push({ type: 'message', id, message: { role, content: [{ type: 'text', text: id }] } });
      m.setLeaf('e3');
      await harness.settle('worker-1');
      return m;
    })();
    const args = { sessionId: 'worker-1', entryId: 'e1', prompt: 'RUN AGAIN', clientRequestId: 'rw-1' };
    await harness.service.call('orch', 'session_rewind', args);
    await harness.settle('worker-1');
    manager.setLeaf('e3');
    await expect(harness.service.call('orch', 'session_rewind', args)).resolves.toMatchObject({ prompted: true, deduplicated: true });
    expect(manager.getLeafId()).toBe('e3');
    await expectCode(harness.service.call('orch', 'session_rewind', { ...args, entryId: 'e2' }), 'OPERATION_PAYLOAD_MISMATCH');
  });

  it('spawns in wait mode without ever cancelling the worker', async () => {
    const { service, deps, settle } = createHarness();
    await expect(service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', mode: 'wait', timeoutMs: 10 }))
      .resolves.toMatchObject({ sessionId: 'worker-1', state: 'busy', timedOut: true });
    expect(deps.abortSession).not.toHaveBeenCalled();

    const waiting = service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two', mode: 'wait', timeoutMs: 5_000 });
    await vi.waitFor(() => expect(deps.sendInput).toHaveBeenCalledTimes(2));
    // The call count is reached before the input is admitted; settle after it.
    await deps.sendInput.mock.results[1].value;
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

  it('wakes the owner with a turn-starting events message when a worker run ends', async () => {
    const { service, orchestrator, settle, runtimes } = createHarness();
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one', role: 'research' });
    await settle('worker-1', 'research result');

    await vi.waitFor(() => expect(orchestrator.delivered).toHaveLength(1));
    const [{ message, options }] = orchestrator.delivered;
    expect(options).toEqual({ triggerTurn: true, deliverAs: 'followUp' });
    expect(message).toMatchObject({
      customType: EVENTS_MESSAGE,
      display: true,
      details: { events: [expect.objectContaining({ sessionId: 'worker-1', kind: 'run_finished', reason: 'research result' })] },
    });
    expect(RESULT_MESSAGE).toBe('pichamber.orchestration.result');

    runtimes.get('worker-1').session.messages.push({ role: 'assistant', content: [], stopReason: 'error', errorMessage: '429 rate limited' });
    await service.onSessionSettled('worker-1', runtimes.get('worker-1'));
    await vi.waitFor(() => expect(orchestrator.delivered).toHaveLength(2));
    expect(orchestrator.delivered[1].message.details.events).toEqual([
      expect.objectContaining({ sessionId: 'worker-1', kind: 'run_failed', reason: '429 rate limited' }),
    ]);
  });

  it('wakes the owner when a worker asks through worker_report', async () => {
    const harness = createHarness();
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await harness.service.call('worker-1', 'worker_report', { kind: 'question', summary: 'Which branch?', audience: 'orchestrator' });
    await vi.waitFor(() => expect(harness.orchestrator.delivered).toHaveLength(1));
    expect(harness.orchestrator.delivered[0].message.details.events).toEqual([
      expect.objectContaining({ sessionId: 'worker-1', kind: 'question', reason: 'Which branch?' }),
    ]);
  });

  describe('event routing (#156)', () => {
    const wakeReasons = (orchestrator) => orchestrator.delivered.flatMap(({ message }) => message.details.events.map((event) => `${event.kind}: ${event.reason}`));

    it('lets the last writer decide: an owner prompt ends without run_finished, a session_send run with one', async () => {
      const { service, orchestrator, settle, input } = createHarness();
      await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
      await settle('worker-1', 'spawn run');
      await vi.waitFor(() => expect(orchestrator.delivered).toHaveLength(1));

      await input('worker-1', { source: 'owner' });
      await settle('worker-1', 'owner run');
      await service.call('orch', 'session_send', { sessionId: 'worker-1', text: 'again' });
      await settle('worker-1', 'orchestrator run');
      await vi.waitFor(() => expect(orchestrator.delivered).toHaveLength(2));
      expect(wakeReasons(orchestrator)).toEqual(['run_finished: spawn run', 'run_finished: orchestrator run']);

      // The owner writes last again: silent.
      await input('worker-1', { source: 'owner' });
      await settle('worker-1', 'owner again');
      await new Promise((done) => { setTimeout(done, 20); });
      expect(wakeReasons(orchestrator)).not.toContain('run_finished: owner again');
    });

    it('still reports failure and done of a run the owner started', async () => {
      const { service, orchestrator, settle, input, runtimes } = createHarness();
      await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
      await settle('worker-1', 'spawn run');
      await input('worker-1', { source: 'owner' });
      runtimes.get('worker-1').session.messages.push({ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'boom' });
      await settle('worker-1');
      await vi.waitFor(() => expect(wakeReasons(orchestrator)).toContain('run_failed: boom'));

      await input('worker-1', { source: 'owner' });
      await service.recordDoneReport('worker-1');
      await settle('worker-1', 'all finished');
      await vi.waitFor(() => expect(wakeReasons(orchestrator)).toContain('done: all finished'));
      expect(wakeReasons(orchestrator)).not.toContain('run_finished: all finished');
    });

    it('reports the done a settle held back for an open input once, when that input closes', async () => {
      const harness = createHarness({ overrides: { readSettings: async () => ({ workerLimit: 4, gate: { enabled: false }, roles: ROLES, wakes: { coalesceMs: 0 }, orchestrators: MARKED, quietWorkers: ['worker-1'] }) } });
      const { service, orchestrator, settle, input, workers } = harness;
      await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
      await settle('worker-1', 'spawn run');
      await input('worker-1', { source: 'owner' });
      await service.call('worker-1', 'worker_report', { kind: 'done', summary: 'complete', evidence: ['tests pass'], pullRequest: 12 });
      // Another input waits for its verdict when the run ends: the settle is held.
      const open = await service.admitInput('worker-1', 'owner');
      await settle('worker-1', 'all finished');
      expect((await workers())['worker-1'].state).not.toBe('done');
      await new Promise((done) => { setTimeout(done, 20); });
      expect(wakeReasons(orchestrator)).not.toContain('done: all finished');

      // The input is rejected by the preflight: the held settle applies now.
      await service.resolveInput(open, 'rejected');
      await vi.waitFor(() => expect(wakeReasons(orchestrator)).toContain('done: all finished'));
      expect((await workers())['worker-1'].state).toBe('done');
      await new Promise((done) => { setTimeout(done, 20); });
      expect(wakeReasons(orchestrator).filter((reason) => reason.startsWith('done:'))).toEqual(['done: all finished']);
    });

    it('does not wake for a report to the owner, and wakes for blocker and ready with their own kinds', async () => {
      const { service, orchestrator } = createHarness();
      await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
      const asked = await service.call('worker-1', 'worker_report', { kind: 'question', summary: 'OWNER QUESTION', audience: 'owner' });
      const owned = await service.call('worker-1', 'worker_report', { kind: 'blocked', summary: 'OWNER BLOCKER', audience: 'owner', resolves: asked.openQuestion });
      await service.call('worker-1', 'worker_report', { kind: 'blocked', summary: 'NEED KEY', audience: 'orchestrator', resolves: owned.openQuestion });
      await service.call('worker-1', 'worker_report', { kind: 'ready', summary: 'PR is up', pullRequest: 12 });
      await vi.waitFor(() => expect(wakeReasons(orchestrator)).toEqual(['blocked: NEED KEY', 'ready: PR is up']));
    });

    it('delivers only the important events of a quiet worker and all of a following one', async () => {
      const harness = createHarness({ overrides: { readSettings: async () => ({ workerLimit: 4, gate: { enabled: false }, roles: ROLES, wakes: { coalesceMs: 0 }, orchestrators: MARKED, quietWorkers: ['worker-1'] }) } });
      const { service, orchestrator, settle } = harness;
      await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
      await service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' });
      await settle('worker-1', 'quiet run');
      await settle('worker-2', 'loud run');
      const asked = await service.call('worker-1', 'worker_report', { kind: 'question', summary: 'quiet question', audience: 'orchestrator' });
      await service.call('worker-1', 'worker_report', { kind: 'blocked', summary: 'quiet blocker', audience: 'orchestrator', resolves: asked.openQuestion });
      await vi.waitFor(() => expect(wakeReasons(orchestrator)).toEqual(expect.arrayContaining(['run_finished: loud run', 'blocked: quiet blocker'])));
      expect(wakeReasons(orchestrator)).not.toContain('run_finished: quiet run');
      expect(wakeReasons(orchestrator)).not.toContain('question: quiet question');

      // The digest and the list show the quiet worker like any other.
      const digest = await service.call('orch', 'orchestration_digest', {});
      expect(digest.workers.map((worker) => worker.sessionId).sort()).toEqual(['worker-1', 'worker-2']);
    });
  });

  it('wakes the owner when an extension dialog opens in a worker, and not for a dialog elsewhere', async () => {
    const harness = createHarness();
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    harness.service.onDialogOpened('orch', 'Own dialog');
    harness.service.onDialogOpened('worker-1', 'Allow network?');
    await vi.waitFor(() => expect(harness.orchestrator.delivered).toHaveLength(1));
    expect(harness.orchestrator.delivered[0].message.details.events).toEqual([
      expect.objectContaining({ sessionId: 'worker-1', kind: 'question', reason: 'dialog: Allow network?' }),
    ]);
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

  it('starts each worker with the profile of its role or the requested one and records it in lineage, registry and reports (#151)', async () => {
    const harness = createHarness({ workerLimit: 10 });
    const { service, deps, runtimes } = harness;
    const readOnly = { name: 'read-only', excludeTools: expect.arrayContaining(['edit', 'write', '*subagent*']), excludeExtensions: [] };
    const review = await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'review', role: 'review' });
    const research = await service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'research', role: 'research' });
    const chosen = await service.call('orch', 'session_spawn', {
      cwd: '/work/c', task: 'own', role: 'review', profile: 'full', excludeExtensions: ['npm:pi-intercom'],
    });
    expect([review.profile, research.profile, chosen.profile]).toEqual(['read-only', 'full', 'full']);
    const lineages = deps.createWorkerSession.mock.calls.map(([options]) => options.lineage.profile);
    expect(lineages).toEqual([readOnly, { name: 'full', excludeTools: [], excludeExtensions: [] }, { name: 'full', excludeTools: [], excludeExtensions: ['npm:pi-intercom'] }]);
    expect((await harness.workers())[review.sessionId].profile).toEqual(readOnly);
    // The daemon's enforcement reads the record from the session itself.
    expect(service.sessionProfile(runtimes.get(review.sessionId).session.sessionManager)).toEqual(readOnly);
    expect(service.sessionProfile(harness.orchestrator.session.sessionManager)).toBeUndefined();
    const digest = await service.call('orch', 'orchestration_digest', {});
    expect(digest.workers.find((worker) => worker.sessionId === review.sessionId).profile).toEqual(readOnly);
    const read = await service.call('orch', 'session_read', { sessionId: review.sessionId });
    expect(read.profile).toEqual(readOnly);
    const capabilities = await service.call('orch', 'orchestration_capabilities');
    expect(capabilities.roleProfiles).toEqual({ review: 'read-only', oracle: 'read-only' });
    expect(Object.keys(capabilities.profiles)).toEqual(['full', 'read-only']);
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/d', task: 'x', profile: 'sandbox' }), 'INVALID_ARGUMENT');
    expect(deps.createWorkerSession).toHaveBeenCalledTimes(3);
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
      first: await harness.service.admitInput('worker-1'),
      second: await harness.service.admitInput('worker-1'),
    };
    expect((await harness.workers())['worker-1'].state).toBe('active');
    for (const name of order) await harness.service.resolveInput(tickets[name], 'queued');
    expect((await harness.workers())['worker-1'].state).toBe('done');
    await expect(harness.service.call('orch', 'orchestration_capabilities')).resolves.toMatchObject({ freeSlots: 1 });
  });

  it('keeps the slot when one of two parallel inputs started a run', async () => {
    const harness = createHarness({ workerLimit: 1 });
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await finishWorker(harness, 'worker-1');
    const first = await harness.service.admitInput('worker-1');
    const second = await harness.service.admitInput('worker-1');
    await harness.service.resolveInput(first, 'started');
    await harness.service.resolveInput(second, 'queued');
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
    await harness.service.beforeSessionInput('orch');
    await expect(harness.service.admitInput('orch')).resolves.toBeNull();
    await expect(harness.service.beforeSessionInput('worker-x')).rejects.toThrow();
    await expect(harness.service.admitInput('worker-x')).rejects.toThrow();
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
    const woken = () => harness.orchestrator.delivered.flatMap((entry) => entry.message.details.events.map((event) => event.sessionId));
    await vi.waitFor(() => expect(woken()).toEqual(expect.arrayContaining(['worker-1', 'worker-2'])));
    harness.orchestrator.delivered.length = 0;

    await expect(harness.service.call('orch-2', 'orchestration_takeover', { fromSessionId: 'orch' }))
      .resolves.toMatchObject({ fromSessionId: 'orch', workers: ['worker-1', 'worker-2'] });
    const listed = await harness.service.call('orch-2', 'session_list', {});
    expect(listed.sessions.map((worker) => [worker.sessionId, worker.lifecycle])).toEqual([['worker-1', 'active'], ['worker-2', 'done']]);
    await expect(harness.service.call('orch', 'session_list', {})).resolves.toEqual({ sessions: [] });
    await expectCode(harness.service.call('orch', 'session_stop', { sessionId: 'worker-1' }), 'ORCHESTRATION_FORBIDDEN');

    await harness.service.call('orch-2', 'session_send', { sessionId: 'worker-1', text: 'more' });
    await harness.settle('worker-1', 'for the successor');
    await vi.waitFor(() => expect(successor.delivered).toHaveLength(1));
    expect(harness.orchestrator.delivered).toHaveLength(0);
    expect(successor.delivered[0].message.details.events.map((event) => event.sessionId)).toEqual(['worker-1']);
    await expect(harness.service.call('orch-2', 'session_stop', { sessionId: 'worker-1' })).resolves.toMatchObject({ stopped: ['worker-1'] });
  });

  it('lets an input admitted before a stop finish, aborts the run it started and refuses inputs behind the stop', async () => {
    const harness = createHarness();
    const { service, deps, states, settle } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await settle('worker-1', 'first');
    // An input was admitted and waits for Pi's verdict.
    const ticket = await service.admitInput('worker-1');
    const stopping = service.call('orch', 'session_stop', { sessionId: 'worker-1' });
    await vi.waitFor(async () => expect((await harness.workers())['worker-1'].stopping).toBeDefined());
    await expectCode(harness.input('worker-1'), 'ORCHESTRATION_WORKER_STOPPING');
    expect(deps.abortSession).not.toHaveBeenCalled();
    states.set('worker-1', 'busy');
    await service.resolveInput(ticket, 'started');
    await expect(stopping).resolves.toMatchObject({ stopped: ['worker-1'] });
    expect(deps.abortSession).toHaveBeenCalledTimes(1);
    expect(states.get('worker-1')).toBe('idle');
    expect((await harness.workers())['worker-1'].state).toBe('stopped');
  });

  it.each(['free', 'taken'])('decides an input let in before a stop of another daemon again once it holds the session (directory %s)', async (directory) => {
    const first = createHarness();
    const second = createHarness({ file: first.file, workerPrefix: 'other' });
    await first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await first.settle('worker-1', 'first');
    // The other daemon let the input in and waits for the session lease.
    const lease = deferred();
    const admitted = deferred();
    const prompt = second.input('worker-1', { beforeStart: async () => { admitted.resolve(); await lease.promise; } });
    await admitted.promise;
    await expect(first.service.call('orch', 'session_stop', { sessionId: 'worker-1' })).resolves.toMatchObject({ stopped: ['worker-1'] });
    if (directory === 'taken') await first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'two' });
    lease.resolve();
    if (directory === 'taken') {
      await expectCode(prompt, 'ORCHESTRATION_CWD_BUSY');
      expect(second.states.get('worker-1')).toBeUndefined();
      expect((await first.workers())['worker-1'].state).toBe('stopped');
    } else {
      await prompt;
      expect(second.states.get('worker-1')).toBe('busy');
      // The run holds a slot and the directory like any restart.
      expect((await first.workers())['worker-1']).toMatchObject({ state: 'active' });
      expect((await first.workers())['worker-1'].admission).toBeUndefined();
    }
  });

  it('refuses an input let in before a stop of another daemon that is still aborting', async () => {
    const first = createHarness();
    const second = createHarness({ file: first.file, workerPrefix: 'other' });
    await first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await first.settle('worker-1', 'first');
    const lease = deferred();
    const admitted = deferred();
    const prompt = second.input('worker-1', { beforeStart: async () => { admitted.resolve(); await lease.promise; } });
    await admitted.promise;
    const abort = deferred();
    first.deps.abortSession.mockImplementationOnce(async () => { await abort.promise; });
    const stopping = first.service.call('orch', 'session_stop', { sessionId: 'worker-1' });
    await vi.waitFor(() => expect(first.deps.abortSession).toHaveBeenCalledTimes(1));
    lease.resolve();
    await expectCode(prompt, 'ORCHESTRATION_WORKER_STOPPING');
    expect(second.states.get('worker-1')).toBeUndefined();
    abort.resolve();
    await expect(stopping).resolves.toMatchObject({ stopped: ['worker-1'] });
    expect((await first.workers())['worker-1'].state).toBe('stopped');
  });

  it('gives a slot to an input let in during a live run when that run made the worker done before the input started', async () => {
    const harness = createHarness({ workerLimit: 1 });
    const { service, states, settle } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await service.recordDoneReport('worker-1');
    // A follow-up is let in while the run is live, so it needs no slot yet.
    const admitted = deferred();
    const preflight = deferred();
    const prompt = harness.input('worker-1', { beforeStart: async () => { admitted.resolve(); await preflight.promise; } });
    await admitted.promise;
    await settle('worker-1', 'finished');
    expect((await harness.workers())['worker-1'].state).toBe('done');
    preflight.resolve();
    await prompt;
    expect(states.get('worker-1')).toBe('busy');
    expect((await harness.workers())['worker-1'].state).toBe('active');
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');
  });

  it('shares a running stop with a parallel stop of the same owner, so a takeover stays busy until it ends', async () => {
    const harness = createHarness();
    const { service, deps } = harness;
    harness.add(createRuntime({ sessionId: 'orch-2' }));
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    const hold = deferred();
    deps.abortSession.mockImplementationOnce(async () => { await hold.promise; });
    deps.abortSession.mockImplementationOnce(async () => { throw Object.assign(new Error('no'), { code: 'ABORT_REJECTED' }); });
    const first = service.call('orch', 'session_stop', { sessionId: 'worker-1' });
    await vi.waitFor(() => expect(deps.abortSession).toHaveBeenCalledTimes(1));
    const second = service.call('orch', 'session_stop', { sessionId: 'worker-1' }).catch((error) => error);
    // Long enough for a second stop of its own to fail and drop its claim.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expectCode(service.call('orch-2', 'orchestration_takeover', { fromSessionId: 'orch' }), 'ORCHESTRATION_TAKEOVER_BUSY');
    hold.resolve();
    await expect(first).resolves.toMatchObject({ stopped: ['worker-1'] });
    await expect(second).resolves.toMatchObject({ stopped: ['worker-1'] });
    expect(deps.abortSession).toHaveBeenCalledTimes(1);
  });

  it('refuses a stop while another live process holds the claim, and a stop that lost its claim reports no success', async () => {
    const first = createHarness();
    await first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    const hold = deferred();
    first.deps.abortSession.mockImplementationOnce(async () => { await hold.promise; });
    const running = first.service.call('orch', 'session_stop', { sessionId: 'worker-1' }).catch((error) => error);
    await vi.waitFor(() => expect(first.deps.abortSession).toHaveBeenCalledTimes(1));

    const other = createHarness({ file: first.file });
    other.add(createRuntime({ sessionId: 'worker-1' }));
    await expect(other.service.call('orch', 'session_stop', { sessionId: 'worker-1' })).rejects.toMatchObject({
      code: 'ORCHESTRATION_STOP_FAILED',
      details: { stopped: [], failed: [{ sessionId: 'worker-1', code: 'ORCHESTRATION_STOP_BUSY' }] },
    });
    expect(other.deps.abortSession).not.toHaveBeenCalled();

    await first.registry.update((document) => { delete document.workers['worker-1'].stopping; });
    hold.resolve();
    expect(await running).toMatchObject({
      code: 'ORCHESTRATION_STOP_FAILED',
      details: { stopped: [], failed: [{ sessionId: 'worker-1', code: 'ORCHESTRATION_STOP_CLAIM_LOST' }] },
    });
    expect((await first.workers())['worker-1'].state).not.toBe('stopped');
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

describe('orchestration input admission (#125 round 5)', () => {
  const pausedRead = (harness) => {
    const paused = deferred();
    const reached = deferred();
    const read = harness.registry.read.bind(harness.registry);
    vi.spyOn(harness.registry, 'read').mockImplementationOnce(async () => { reached.resolve(); await paused.promise; return read(); });
    return { reached: reached.promise, release: paused.resolve };
  };

  it.each(['limit', 'directory'])('keeps a run another daemon started while this daemon\'s input to the stopped worker fails on the lease (%s)', async (guard) => {
    const first = createHarness({ workerLimit: guard === 'limit' ? 1 : 2 });
    const second = createHarness({ file: first.file, workerLimit: guard === 'limit' ? 1 : 2, workerPrefix: 'other' });
    await first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await first.settle('worker-1', 'first');
    await first.service.call('orch', 'session_stop', { sessionId: 'worker-1' });
    // This daemon's input waits for a lease the other daemon holds.
    const lookup = deferred();
    const looking = deferred();
    const failing = first.input('worker-1', { beforeStart: async () => {
      looking.resolve();
      await lookup.promise;
      throw Object.assign(new Error('in use'), { code: 'SESSION_IN_USE' });
    } });
    await looking.promise;
    await second.input('worker-1');
    lookup.resolve();
    await expectCode(failing, 'SESSION_IN_USE');
    expect((await first.workers())['worker-1'].state).toBe('active');
    if (guard === 'limit') {
      await expectCode(first.service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');
    } else {
      await expectCode(first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'two' }), 'ORCHESTRATION_CWD_BUSY');
    }
  });

  // Oracle addendum to R8: a settle while the run's prompt still goes on
  // (Pi waits to retry; no run signal then) is no end of that run.
  it.each(['limit', 'directory'])('keeps the slot of a run until its prompt ended, also after a settle and a done report (%s)', async (guard) => {
    const harness = createHarness({ workerLimit: guard === 'limit' ? 1 : 2 });
    const { service } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await finishWorker(harness, 'worker-1');
    await harness.input('worker-1');
    expect(await service.recordDoneReport('worker-1')).toBe(true);
    await harness.settle('worker-1', 'attempt failed', { ended: false });
    expect((await harness.workers())['worker-1'].state).toBe('active');
    await expectCode(guardSpawn(service, guard), guardCode(guard));
    await harness.endPrompts('worker-1');
    expect((await harness.workers())['worker-1'].state).toBe('done');
    await expect(guardSpawn(service, guard)).resolves.toMatchObject({ sessionId: 'worker-2' });
  });

  it('returns the slot of an input that started no run after a sibling input\'s run ended', async () => {
    const harness = createHarness({ workerLimit: 1 });
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await finishWorker(harness, 'worker-1');
    const lease = deferred();
    const waiting = deferred();
    const sibling = harness.input('worker-1', { outcome: 'handled', beforeStart: async () => { waiting.resolve(); await lease.promise; } });
    await waiting.promise;
    await harness.input('worker-1');
    await finishWorker(harness, 'worker-1');
    lease.resolve();
    await sibling;
    expect((await harness.workers())['worker-1'].state).toBe('done');
    await expect(harness.service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' })).resolves.toMatchObject({ sessionId: 'worker-2' });
  });

  it('keeps the slot for a run an input admitted during the previous run started after that run settled', async () => {
    const harness = createHarness({ workerLimit: 1 });
    const { service, settle } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await service.recordDoneReport('worker-1');
    // Pi's input handlers run after the admission, so the run can settle
    // before Pi decides that the input starts a new run.
    const handlers = deferred();
    const admitted = deferred();
    const prompt = harness.input('worker-1', { beforeVerdict: async () => { admitted.resolve(); await handlers.promise; } });
    await admitted.promise;
    await settle('worker-1', 'finished');
    expect((await harness.workers())['worker-1'].state).toBe('active');
    handlers.resolve();
    await prompt;
    expect((await harness.workers())['worker-1'].state).toBe('active');
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');
    // The new run ends the worker only through its own done report.
    await settle('worker-1', 'second');
    expect((await harness.workers())['worker-1'].state).toBe('active');
    // A done report needs a live run of this service (R8).
    expect(await service.recordDoneReport('worker-1')).toBe(false);
    await harness.input('worker-1');
    await finishWorker(harness, 'worker-1');
  });

  it('applies a settle held for an admitted input once that input starts no run', async () => {
    const harness = createHarness({ workerLimit: 1 });
    const { service, settle } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await service.recordDoneReport('worker-1');
    const handlers = deferred();
    const admitted = deferred();
    const prompt = harness.input('worker-1', { outcome: 'queued', beforeVerdict: async () => { admitted.resolve(); await handlers.promise; } });
    await admitted.promise;
    await settle('worker-1', 'finished');
    handlers.resolve();
    await prompt;
    expect((await harness.workers())['worker-1'].state).toBe('done');
  });

  it('ignores the late settle of an earlier run once a later run started', async () => {
    const harness = createHarness({ workerLimit: 1 });
    const { service } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await finishWorker(harness, 'worker-1');
    await harness.input('worker-1');
    // The run settles, but its settle waits before it reaches the registry.
    const read = pausedRead(harness);
    const settling = harness.settle('worker-1', 'second');
    await read.reached;
    await harness.input('worker-1');
    await service.recordDoneReport('worker-1');
    read.release();
    await settling;
    expect((await harness.workers())['worker-1'].state).toBe('active');
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');
  });

  it('keeps the slot and reports it when the start of an admitted input cannot be recorded', async () => {
    const harness = createHarness({ workerLimit: 1 });
    const { service, deps } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await finishWorker(harness, 'worker-1');
    await harness.input('worker-1', { beforeVerdict: async () => {
      vi.spyOn(harness.registry, 'update').mockRejectedValueOnce(Object.assign(new Error('disk'), { code: 'EIO' }));
    } }).catch(() => {});
    expect((await harness.workers())['worker-1'].state).toBe('active');
    expect(deps.onAdmissionUnresolved).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'worker-1' }));
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');
    // The run's settle ends the admission like any run.
    await finishWorker(harness, 'worker-1');
    expect((await harness.workers())['worker-1'].admission).toBeUndefined();
  });

  it('shows an input accepted without a verdict as unresolved, keeps its slot and aborts the run a late verdict starts after a stop', async () => {
    const harness = createHarness({ workerLimit: 1 });
    const { service, deps } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await finishWorker(harness, 'worker-1');
    const { ticket } = await harness.input('worker-1', { outcome: 'unresolved' });
    expect((await harness.workers())['worker-1']).toMatchObject({ state: 'active', admission: { state: 'unresolved' } });
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');
    // A stop does not wait for an unresolved input.
    await expect(service.call('orch', 'session_stop', { sessionId: 'worker-1' })).resolves.toMatchObject({ stopped: ['worker-1'] });
    expect((await harness.workers())['worker-1'].admission).toBeUndefined();
    deps.abortSession.mockClear();
    const run = new AbortController().signal;
    // A late verdict runs outside the daemon's prompt: its end has no proof.
    const { completion } = await harness.verdict(ticket, 'started', { run: Promise.resolve(run), finished: null });
    expect(deps.abortRun).toHaveBeenCalledWith('worker-1', run);
    expect(deps.abortSession).not.toHaveBeenCalled();
    await completion;
    expect((await harness.workers())['worker-1']).toMatchObject({ state: 'stopped', hold: { reason: 'unproven_run' } });
  });

  it('gives an unresolved input the slot of the run its late verdict starts and holds it, since that run\'s end cannot be proven', async () => {
    const harness = createHarness({ workerLimit: 1 });
    const { service, deps } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await finishWorker(harness, 'worker-1');
    const { ticket } = await harness.input('worker-1', { outcome: 'unresolved' });
    const { completion } = await harness.verdict(ticket, 'started', { finished: null });
    await completion;
    const worker = (await harness.workers())['worker-1'];
    expect(worker).toMatchObject({ state: 'active', hold: { reason: 'unproven_run' } });
    expect(worker.admission).toBeUndefined();
    expect(deps.onAdmissionUnresolved).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'worker-1', error: expect.objectContaining({ code: 'ORCHESTRATION_RUN_UNPROVEN' }),
    }));
    // Neither a settle nor done ends it (the documented limit).
    await service.recordDoneReport('worker-1');
    await harness.settle('worker-1', 'finished');
    expect((await harness.workers())['worker-1']).toMatchObject({ state: 'active', hold: { reason: 'unproven_run' } });
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'two' }), 'ORCHESTRATION_LIMIT');
  });

  it('waits for an admitted input before a stop finishes, and frees the slot after an input that started no run', async () => {
    const harness = createHarness({ workerLimit: 1 });
    const { service, deps } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await finishWorker(harness, 'worker-1');
    const ticket = await service.admitInput('worker-1');
    const stopping = service.call('orch', 'session_stop', { sessionId: 'worker-1' });
    await vi.waitFor(async () => expect((await harness.workers())['worker-1'].stopping).toBeDefined());
    await service.resolveInput(ticket, 'handled');
    await expect(stopping).resolves.toMatchObject({ stopped: ['worker-1'] });
    expect(deps.abortSession).toHaveBeenCalledTimes(1);
    await expect(service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'two' })).resolves.toMatchObject({ sessionId: 'worker-2' });
  });

  it('keeps the slot of a run whose start could not be recorded when a sibling input starts no run', async () => {
    const harness = createHarness({ workerLimit: 1 });
    const { service } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await finishWorker(harness, 'worker-1');
    await harness.input('worker-1', { beforeVerdict: async () => {
      vi.spyOn(harness.registry, 'update').mockRejectedValueOnce(Object.assign(new Error('disk'), { code: 'EIO' }));
    } });
    // A follow-up of the same admission is queued behind the running run.
    await harness.input('worker-1', { outcome: 'queued' });
    expect((await harness.workers())['worker-1'].state).toBe('active');
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');
    await finishWorker(harness, 'worker-1');
    expect((await harness.workers())['worker-1']).toMatchObject({ state: 'done' });
    expect((await harness.workers())['worker-1'].admission).toBeUndefined();
  });

  it('keeps the slot for a second deferred input after the first one\'s run settled', async () => {
    const harness = createHarness({ workerLimit: 1 });
    const { service, settle } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    // Pi defers both prompts behind the settle of the running run.
    const first = await harness.input('worker-1', { outcome: 'unresolved' });
    const second = await harness.input('worker-1', { outcome: 'unresolved' });
    await settle('worker-1', 'first');
    // Pi runs the first deferred prompt; that run reports done and settles
    // while the second prompt has not reached its preflight.
    // A late verdict: that run's end has no proof.
    await (await harness.verdict(first.ticket, 'started', { finished: null })).completion;
    await service.recordDoneReport('worker-1');
    await settle('worker-1', 'second');
    expect((await harness.workers())['worker-1']).toMatchObject({ state: 'active', admission: { state: 'unresolved' } });
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'two' }), 'ORCHESTRATION_LIMIT');
    // The second prompt starts no run; the first run's unproven end keeps
    // the slot and the directory.
    await service.resolveInput(second.ticket, 'queued');
    expect((await harness.workers())['worker-1']).toMatchObject({ state: 'active', hold: { reason: 'unproven_run' } });
    expect((await harness.workers())['worker-1'].admission).toBeUndefined();
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'two' }), 'ORCHESTRATION_LIMIT');
  });

  const guardCode = (guard) => (guard === 'limit' ? 'ORCHESTRATION_LIMIT' : 'ORCHESTRATION_CWD_BUSY');
  const guardSpawn = (service, guard) => service.call('orch', 'session_spawn', { cwd: guard === 'limit' ? '/work/b' : '/work/a', task: 'two' });

  it.each(['limit', 'directory'])('never gives a run whose start could not be recorded the generation of a later start of the same admission (%s)', async (guard) => {
    const harness = createHarness({ workerLimit: guard === 'limit' ? 1 : 2 });
    const { service, settle } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    // Pi defers two prompts behind the running run; they share one admission.
    const a = await harness.input('worker-1', { outcome: 'unresolved' });
    const b = await harness.input('worker-1', { outcome: 'unresolved' });
    expect(a.ticket.admission).toBe(b.ticket.admission);
    await settle('worker-1', 'first');
    // A starts a run; recording its start fails.
    vi.spyOn(harness.registry, 'update').mockRejectedValueOnce(Object.assign(new Error('disk'), { code: 'EIO' }));
    const aEnd = deferred();
    const ranA = await harness.verdict(a.ticket, 'started', { run: Promise.resolve({ signal: 'a' }), finished: aEnd.promise });
    // A's prompt proves A's end; applying it waits on the registry while B
    // starts, reports done and still runs.
    const paused = pausedRead(harness);
    await settle('worker-1', 'a');
    aEnd.resolve(true);
    await paused.reached;
    const bEnd = deferred();
    const ranB = await harness.verdict(b.ticket, 'started', { run: Promise.resolve({ signal: 'b' }), finished: bEnd.promise });
    expect(await service.recordDoneReport('worker-1')).toBe(true);
    paused.release();
    await ranA.completion;
    expect((await harness.workers())['worker-1'].state).toBe('active');
    await expectCode(guardSpawn(service, guard), guardCode(guard));
    // B's own end applies its done report.
    await settle('worker-1', 'b');
    bEnd.resolve(true);
    await ranB.completion;
    expect((await harness.workers())['worker-1'].state).toBe('done');
  });

  it.each(['limit', 'directory'])('keeps the slot and directory of a stopped worker while an input Pi accepted is unsettled (%s)', async (guard) => {
    const harness = createHarness({ workerLimit: guard === 'limit' ? 1 : 2 });
    const { service } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await finishWorker(harness, 'worker-1');
    const pending = await harness.input('worker-1', { outcome: 'unresolved' });
    await expect(service.call('orch', 'session_stop', { sessionId: 'worker-1' }))
      .resolves.toEqual({ sessionId: 'worker-1', stopped: ['worker-1'], held: ['worker-1'] });
    expect((await harness.workers())['worker-1']).toMatchObject({ state: 'stopped', hold: { reason: 'unresolved_input' } });
    await expectCode(guardSpawn(service, guard), guardCode(guard));
    // Pi queues the input instead of starting a run: the hold ends.
    await service.resolveInput(pending.ticket, 'queued');
    expect((await harness.workers())['worker-1'].hold).toBeUndefined();
    await expect(guardSpawn(service, guard)).resolves.toMatchObject({ sessionId: 'worker-2' });
  });

  it.each(['limit', 'directory'])('keeps the slot of a stopped worker until the prompt of the run a stale input started proves its end (%s)', async (guard) => {
    const harness = createHarness({ workerLimit: guard === 'limit' ? 1 : 2 });
    const { service, deps, settle } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await finishWorker(harness, 'worker-1');
    const pending = await harness.input('worker-1', { outcome: 'unresolved' });
    await service.call('orch', 'session_stop', { sessionId: 'worker-1' });
    const run = { signal: 'late-run' };
    const end = deferred();
    const { completion } = await harness.verdict(pending.ticket, 'started', { run: Promise.resolve(run), finished: end.promise });
    expect(deps.abortRun).toHaveBeenCalledWith('worker-1', run);
    // Aborted, but not ended yet; a settle is no proof.
    await expectCode(guardSpawn(service, guard), guardCode(guard));
    await settle('worker-1', 'aborted');
    expect((await harness.workers())['worker-1']).toMatchObject({ state: 'stopped', hold: { reason: 'unresolved_input' } });
    await expectCode(guardSpawn(service, guard), guardCode(guard));
    end.resolve(true);
    await completion;
    expect((await harness.workers())['worker-1']).toMatchObject({ state: 'stopped' });
    expect((await harness.workers())['worker-1'].hold).toBeUndefined();
    await expect(guardSpawn(service, guard)).resolves.toMatchObject({ sessionId: 'worker-2' });
  });

  it.each(['limit', 'directory'])('holds the slot of a stopped worker for a late verdict\'s aborted run, whose end has no proof (%s)', async (guard) => {
    const harness = createHarness({ workerLimit: guard === 'limit' ? 1 : 2 });
    const { service, deps, settle } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await finishWorker(harness, 'worker-1');
    const pending = await harness.input('worker-1', { outcome: 'unresolved' });
    await service.call('orch', 'session_stop', { sessionId: 'worker-1' });
    const run = { signal: 'late-run' };
    const { completion } = await harness.verdict(pending.ticket, 'started', { run: Promise.resolve(run), finished: null });
    expect(deps.abortRun).toHaveBeenCalledWith('worker-1', run);
    await completion;
    await settle('worker-1', 'aborted');
    expect((await harness.workers())['worker-1']).toMatchObject({ state: 'stopped', hold: { reason: 'unproven_run' } });
    await expectCode(guardSpawn(service, guard), guardCode(guard));
  });

  it('aborts the late run of an input a stop ended and keeps the admission of a later input', async () => {
    const harness = createHarness({ workerLimit: 1 });
    const { service, deps } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await finishWorker(harness, 'worker-1');
    const old = await harness.input('worker-1', { outcome: 'unresolved' });
    await expect(service.call('orch', 'session_stop', { sessionId: 'worker-1' })).resolves.toMatchObject({ stopped: ['worker-1'] });
    // A new input reserves the stopped worker before Pi runs the old prompt.
    const fresh = await harness.input('worker-1', { outcome: 'unresolved' });
    const reserved = (await harness.workers())['worker-1'].admission;
    expect(reserved).toMatchObject({ state: 'unresolved', previous: 'stopped' });
    deps.abortSession.mockClear();
    const run = new AbortController().signal;
    await harness.verdict(old.ticket, 'started', { run: Promise.resolve(run), finished: null });
    // Only the old prompt's own run is aborted, never the session's.
    expect(deps.abortRun).toHaveBeenCalledWith('worker-1', run);
    expect(deps.abortSession).not.toHaveBeenCalled();
    expect((await harness.workers())['worker-1']).toMatchObject({ state: 'active', admission: { token: reserved.token } });
    // The new input's own run takes the slot.
    deps.abortSession.mockClear();
    await harness.verdict(fresh.ticket, 'started', { finished: null });
    expect(deps.abortSession).not.toHaveBeenCalled();
    expect((await harness.workers())['worker-1'].admission).toBeUndefined();
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');
  });

  it.each(['limit', 'directory'])('keeps the slot of a run whose start could not be recorded against the settle of the run before it (%s)', async (guard) => {
    const harness = createHarness({ workerLimit: guard === 'limit' ? 1 : 2 });
    const { service, settle } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await service.recordDoneReport('worker-1');
    // The run that reported done settles; its settle waits on the registry.
    const paused = pausedRead(harness);
    const settling = settle('worker-1', 'first');
    await paused.reached;
    // Pi starts the next run meanwhile; recording its start fails.
    await harness.input('worker-1', { beforeVerdict: async () => {
      vi.spyOn(harness.registry, 'update').mockRejectedValueOnce(Object.assign(new Error('disk'), { code: 'EIO' }));
    } });
    paused.release();
    await settling;
    expect((await harness.workers())['worker-1'].state).toBe('active');
    if (guard === 'limit') {
      await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');
    } else {
      await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'two' }), 'ORCHESTRATION_CWD_BUSY');
    }
    // The new run ends the worker only through its own done report.
    await finishWorker(harness, 'worker-1');
    expect((await harness.workers())['worker-1'].admission).toBeUndefined();
  });

  it('never ends a run whose start could not be recorded with the done report of the run before it', async () => {
    const harness = createHarness({ workerLimit: 1 });
    const { service, settle } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await service.recordDoneReport('worker-1');
    const handlers = deferred();
    const admitted = deferred();
    const prompt = harness.input('worker-1', { beforeVerdict: async () => {
      admitted.resolve();
      await handlers.promise;
      vi.spyOn(harness.registry, 'update').mockRejectedValueOnce(Object.assign(new Error('disk'), { code: 'EIO' }));
    } });
    await admitted.promise;
    await settle('worker-1', 'first');
    handlers.resolve();
    await prompt;
    // The new run settles without a done report of its own.
    await settle('worker-1', 'second');
    expect((await harness.workers())['worker-1'].state).toBe('active');
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');
    await harness.input('worker-1');
    await finishWorker(harness, 'worker-1');
  });

  it('holds a slot for a run a stopped worker\'s input started when that run cannot be aborted on its own', async () => {
    const harness = createHarness({ workerLimit: 1 });
    const { service, deps, settle } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await finishWorker(harness, 'worker-1');
    const { ticket } = await harness.input('worker-1', { outcome: 'unresolved' });
    // Pi accepted the input: the stop ends the worker but keeps its slot.
    await expect(service.call('orch', 'session_stop', { sessionId: 'worker-1' })).resolves.toMatchObject({ held: ['worker-1'] });
    deps.abortSession.mockClear();
    // No handle names the started run, so nothing is aborted: another run of
    // the session might be hit.
    const { completion } = await harness.verdict(ticket, 'started', { run: Promise.resolve(null), finished: null });
    await completion;
    expect(deps.abortSession).not.toHaveBeenCalled();
    expect(deps.abortRun).not.toHaveBeenCalled();
    expect((await harness.workers())['worker-1']).toMatchObject({
      state: 'stopped', hold: { reason: 'unproven_run' },
    });
    expect((await harness.workers())['worker-1'].admission).toBeUndefined();
    expect(deps.onAdmissionUnresolved).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'worker-1', error: expect.objectContaining({ code: 'ORCHESTRATION_RUN_UNPROVEN' }),
    }));
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');
    // A settle cannot be told apart from another run's (R8): the hold stays,
    // slot and directory included.
    await settle('worker-1', 'ran anyway');
    expect((await harness.workers())['worker-1']).toMatchObject({ state: 'stopped', hold: { reason: 'unproven_run' } });
    await expectCode(service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');
    // The holder's process ends: its runs ended with it.
    harness.crash();
    const restarted = createHarness({ workerLimit: 1, file: harness.file, workerPrefix: 'after' });
    await expect(restarted.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'two' })).resolves.toMatchObject({ sessionId: 'after-1' });
  });

  it('refuses an input while another daemon\'s admission of the worker is open', async () => {
    const first = createHarness();
    const second = createHarness({ file: first.file, workerPrefix: 'other' });
    await first.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await finishWorker(first, 'worker-1');
    const ticket = await first.service.admitInput('worker-1');
    await expectCode(second.input('worker-1'), 'ORCHESTRATION_WORKER_BUSY');
    await first.service.resolveInput(ticket, 'rejected');
    expect((await first.workers())['worker-1'].state).toBe('done');
    await second.input('worker-1');
    expect((await first.workers())['worker-1'].state).toBe('active');
  });
});

describe('worker reports and digest', () => {
  const done = { kind: 'done', summary: 'finished', evidence: ['bun run test passed'], noPullRequest: 'docs only' };
  const report = (harness, args, sessionId = 'worker-1') => harness.service.call(sessionId, 'worker_report', args);
  const digest = (harness, args = {}) => harness.service.call('orch', 'orchestration_digest', args);

  it('refuses an incomplete report per kind and changes nothing', async () => {
    const harness = createHarness();
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await harness.settle('worker-1', 'first');
    const before = (await harness.workers())['worker-1'];
    for (const args of [
      { kind: 'done', summary: 'x', noPullRequest: 'none' },
      { kind: 'done', summary: 'x', evidence: ['tests'] },
      { kind: 'ready', summary: 'x' },
      { kind: 'question', summary: 'x' },
      { kind: 'blocked', summary: 'x' },
      { kind: 'progress', summary: 'x'.repeat(301) },
    ]) await expectCode(report(harness, args), 'INVALID_ARGUMENT');
    expect((await harness.workers())['worker-1']).toEqual(before);
  });

  it('lets only workers report and only orchestrators read the digest', async () => {
    const harness = createHarness();
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await expectCode(report(harness, { kind: 'progress', summary: 'x' }, 'orch'), 'ORCHESTRATION_FORBIDDEN');
    await expectCode(harness.service.call('worker-1', 'orchestration_digest', {}), 'ORCHESTRATION_FORBIDDEN');
  });

  it('keeps a question open until a matching resolves closes it', async () => {
    const harness = createHarness();
    const { service } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await harness.settle('worker-1', 'first');
    const asked = await report(harness, { kind: 'question', summary: 'Which API?', audience: 'owner' });
    const id = asked.openQuestion;
    expect(id).toEqual(expect.any(String));

    // An unrelated send, a UI prompt and a progress report leave it open.
    await service.call('orch', 'session_send', { sessionId: 'worker-1', text: 'status?' });
    await harness.settle('worker-1', 'busy');
    await harness.input('worker-1');
    await harness.settle('worker-1', 'still busy');
    await report(harness, { kind: 'progress', summary: 'tests written' });
    const open = (await harness.workers())['worker-1'];
    expect(open.question).toMatchObject({ id, kind: 'question', audience: 'owner', summary: 'Which API?' });
    expect(open.lastInputAt).toEqual(expect.any(Number));

    // A second question is refused unless it names the open one, which it replaces.
    await expectCode(report(harness, { kind: 'blocked', summary: 'stuck', audience: 'orchestrator' }), 'ORCHESTRATION_QUESTION_OPEN');
    await expectCode(report(harness, { kind: 'progress', summary: 'x', resolves: 'q-other' }), 'ORCHESTRATION_QUESTION_UNKNOWN');
    const replaced = await report(harness, { kind: 'blocked', summary: 'stuck', audience: 'orchestrator', resolves: id });
    expect(replaced.openQuestion).not.toBe(id);

    // A send with another id leaves it open; the matching one closes it.
    await expect(service.call('orch', 'session_send', { sessionId: 'worker-1', text: 'no', resolves: id })).resolves.toMatchObject({ resolved: false });
    await harness.settle('worker-1', 'ok');
    await expect(service.call('orch', 'session_send', { sessionId: 'worker-1', text: 'use v2', resolves: replaced.openQuestion }))
      .resolves.toMatchObject({ accepted: true, resolved: true });
    await harness.settle('worker-1', 'ok');
    expect((await harness.workers())['worker-1'].question).toBeUndefined();

    // The worker can close its own question with a report.
    const again = await report(harness, { kind: 'question', summary: 'Merge?', audience: 'orchestrator' });
    await report(harness, { kind: 'progress', summary: 'decided myself', resolves: again.openQuestion });
    expect((await harness.workers())['worker-1'].question).toBeUndefined();
  });

  it('lets the owner answer an open question: an owner prompt, closed only after Pi accepted it', async () => {
    const harness = createHarness();
    const { service, deps } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await harness.settle('worker-1', 'first');
    const brief = { options: ['v1', 'v2'], recommendation: 'v2, it is maintained', counterargument: 'v1 is already wired', revisit: 'when v1 gets a fix' };
    const id = (await report(harness, { kind: 'question', summary: 'Which API?', audience: 'owner', brief })).openQuestion;
    expect((await harness.workers())['worker-1'].question).toMatchObject({ id, brief });
    const sends = () => deps.sendInput.mock.calls.length;
    const before = sends();

    // Another id, another session or a non worker change nothing and send nothing.
    await expectCode(service.answer({ sessionId: 'worker-1', questionId: 'q-other', text: 'v2' }), 'ORCHESTRATION_QUESTION_UNKNOWN');
    await expectCode(service.answer({ sessionId: 'orch', questionId: id, text: 'v2' }), 'ORCHESTRATION_QUESTION_UNKNOWN');
    expect(sends()).toBe(before);

    // A prompt Pi refuses leaves the question open.
    deps.sendInput.mockImplementationOnce(async () => { throw Object.assign(new Error('busy'), { code: 'SESSION_BUSY' }); });
    await expectCode(service.answer({ sessionId: 'worker-1', questionId: id, text: 'v2' }), 'SESSION_BUSY');
    expect((await harness.workers())['worker-1'].question?.id).toBe(id);

    await expect(service.answer({ sessionId: 'worker-1', questionId: id, text: 'v2' }))
      .resolves.toEqual({ sessionId: 'worker-1', questionId: id, accepted: true, resolved: true });
    expect(deps.sendInput).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'worker-1', text: 'v2', delivery: 'prompt', source: 'owner' }));
    expect((await harness.workers())['worker-1'].question).toBeUndefined();
    await harness.settle('worker-1', 'used v2');
    // Answered once: the closed id is no longer open.
    await expectCode(service.answer({ sessionId: 'worker-1', questionId: id, text: 'v2' }), 'ORCHESTRATION_QUESTION_UNKNOWN');
  });

  it('keeps a question that replaced the answered one while the answer was sent', async () => {
    const harness = createHarness();
    const { service, deps } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await harness.settle('worker-1', 'first');
    const id = (await report(harness, { kind: 'question', summary: 'Which API?', audience: 'owner' })).openQuestion;
    let replaced;
    deps.sendInput.mockImplementationOnce(async ({ sessionId, source }) => {
      replaced = (await report(harness, { kind: 'blocked', summary: 'need a key', audience: 'owner', resolves: id })).openQuestion;
      return harness.input(sessionId, { source });
    });
    await expect(service.answer({ sessionId: 'worker-1', questionId: id, text: 'v2' })).resolves.toMatchObject({ accepted: true, resolved: false });
    expect((await harness.workers())['worker-1'].question?.id).toBe(replaced);
  });

  it('marks an open question answered without a prompt, and nothing else', async () => {
    const harness = createHarness();
    const { service, deps } = harness;
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await harness.settle('worker-1', 'first');
    const id = (await report(harness, { kind: 'question', summary: 'Which API?', audience: 'orchestrator' })).openQuestion;
    const before = deps.sendInput.mock.calls.length;
    await expectCode(service.resolve({ sessionId: 'worker-1', questionId: 'q-other' }), 'ORCHESTRATION_QUESTION_UNKNOWN');
    expect((await harness.workers())['worker-1'].question?.id).toBe(id);
    await expect(service.resolve({ sessionId: 'worker-1', questionId: id })).resolves.toEqual({ sessionId: 'worker-1', questionId: id, resolved: true });
    expect((await harness.workers())['worker-1'].question).toBeUndefined();
    expect(deps.sendInput.mock.calls.length).toBe(before);
    await expectCode(service.resolve({ sessionId: 'worker-1', questionId: id }), 'ORCHESTRATION_QUESTION_UNKNOWN');
  });

  it('takes a brief only with a question or blocker, and only with a recommendation', async () => {
    const harness = createHarness();
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await expectCode(report(harness, { kind: 'progress', summary: 'x', brief: { recommendation: 'y' } }), 'INVALID_ARGUMENT');
    await expectCode(report(harness, { kind: 'question', summary: 'x', audience: 'owner', brief: { options: ['a'] } }), 'INVALID_ARGUMENT');
    await expectCode(report(harness, { kind: 'question', summary: 'x', audience: 'owner', brief: { recommendation: 'y', extra: 1 } }), 'INVALID_ARGUMENT');
    expect((await harness.workers())['worker-1'].question).toBeUndefined();
  });

  it('does not repeat a report retried with the same clientRequestId', async () => {
    const harness = createHarness();
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    const args = { kind: 'question', summary: 'Which API?', audience: 'owner', clientRequestId: 'ask-1' };
    const first = await report(harness, args);
    await expect(report(harness, args)).resolves.toMatchObject({ deduplicated: true, openQuestion: first.openQuestion });
  });

  it('keeps a worker that reported done active with its slot until the reporting run settles', async () => {
    const harness = createHarness({ workerLimit: 1 });
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await expect(report(harness, { ...done, noPullRequest: undefined, pullRequest: 42 })).resolves.toMatchObject({ doneAtRunEnd: true });
    expect((await harness.workers())['worker-1']).toMatchObject({
      state: 'starting',
      pullRequest: { number: 42, repository: 'acme/app' },
      report: { kind: 'done', summary: 'finished', pullRequest: 42, evidence: ['bun run test passed'] },
    });
    await expectCode(harness.service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' }), 'ORCHESTRATION_LIMIT');
    await harness.settle('worker-1', 'finished');
    expect((await harness.workers())['worker-1'].state).toBe('done');
    await expect(harness.service.call('orch', 'session_spawn', { cwd: '/work/b', task: 'two' })).resolves.toMatchObject({ sessionId: 'worker-2' });
  });

  it('shows snapshot values with their time and dormant after disposal and restart, activating nothing', async () => {
    let clock = 1_000;
    const harness = createHarness({ now: () => clock });
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    const runtime = harness.runtimes.get('worker-1');
    runtime.stats = { tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 }, cost: 0.25 };
    runtime.session.messages.push({ role: 'assistant', content: [], errorMessage: 'rate limited', stopReason: 'error', timestamp: 900 });
    clock = 2_000;
    await harness.settle('worker-1');
    harness.runtimes.delete('worker-1');
    const expected = {
      sessionId: 'worker-1',
      worktree: '/work/a',
      lifecycle: 'active',
      live: 'dormant',
      liveSince: null,
      lastProgressAt: 900,
      lastError: { message: 'rate limited', at: 900 },
      usage: { settled: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.25 }, settledAt: 2_000 },
      question: null,
      report: null,
      pullRequest: null,
      issue: null,
    };
    harness.deps.activateSession.mockClear();
    expect((await digest(harness)).workers).toEqual([expect.objectContaining(expected)]);
    expect(harness.deps.activateSession).not.toHaveBeenCalled();

    harness.crash();
    const restarted = createHarness({ file: harness.file, workerPrefix: 'after' });
    const after = await digest(restarted);
    expect(after.workers).toEqual([expect.objectContaining(expected)]);
    expect(after.limit).toEqual({ workerLimit: 4, used: 1 });
    expect(restarted.deps.activateSession).not.toHaveBeenCalled();
  });

  it('reports retry, waiting_input, busy and idle from the live channels and null for unknown values', async () => {
    const activity = new Map();
    const harness = createHarness({ activity });
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    const liveOf = async () => {
      const [worker] = (await digest(harness)).workers;
      return { live: worker.live, liveSince: worker.liveSince };
    };
    activity.set('worker-1', { runStartedAt: 500 });
    expect(await liveOf()).toEqual({ live: 'busy', liveSince: 500 });
    harness.states.set('worker-1', 'retry');
    activity.set('worker-1', { runStartedAt: 500, retry: { attempt: 1, message: 'overloaded' } });
    expect(await liveOf()).toEqual({ live: 'retry', liveSince: 500 });
    harness.states.set('worker-1', 'busy');
    activity.set('worker-1', { runStartedAt: 500, waitingForInput: true });
    expect(await liveOf()).toEqual({ live: 'waiting_input', liveSince: 500 });
    const [unsettled] = (await digest(harness)).workers;
    expect(unsettled).toMatchObject({ lastProgressAt: null, lastError: null, usage: null, lastInputAt: expect.any(Number) });
    activity.delete('worker-1');
    await harness.settle('worker-1', 'done');
    expect(await liveOf()).toEqual({ live: 'idle', liveSince: null });
  });

  it('reports waiting_input while an input preflight waits in a dialog before any run starts', async () => {
    const activity = new Map();
    const harness = createHarness({ activity });
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await harness.settle('worker-1', 'done');
    const liveOf = async () => {
      const [worker] = (await digest(harness)).workers;
      return { live: worker.live, liveSince: worker.liveSince };
    };
    // An extension command or input hook asks the owner before Pi starts the
    // agent: the runtime is still idle, only the dialog channel knows.
    const preflight = harness.input('worker-1', {
      outcome: 'rejected',
      beforeVerdict: async () => {
        expect(harness.states.get('worker-1')).toBe('idle');
        activity.set('worker-1', { waitingForInput: true });
        expect(await liveOf()).toEqual({ live: 'waiting_input', liveSince: null });
        activity.delete('worker-1');
      },
    });
    await expect(preflight).rejects.toMatchObject({ code: 'PROMPT_REJECTED' });
    expect(await liveOf()).toEqual({ live: 'idle', liveSince: null });
  });

  it('stays under a tenth of the transcripts session_read returns for four workers', async () => {
    const harness = createHarness();
    const ids = [];
    for (const name of ['a', 'b', 'c', 'd']) {
      const { sessionId } = await harness.service.call('orch', 'session_spawn', { cwd: `/work/${name}`, task: 'one' });
      ids.push(sessionId);
      const runtime = harness.runtimes.get(sessionId);
      for (let index = 0; index < 20; index += 1) {
        runtime.session.sessionManager.getEntries().push({ type: 'message', id: `e${index}`, message: { role: index % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `step ${index} `.repeat(400) }] } });
      }
      await harness.settle(sessionId);
      await report(harness, { kind: 'progress', summary: 'halfway there' }, sessionId);
    }
    let transcripts = 0;
    for (const sessionId of ids) {
      transcripts += JSON.stringify(await harness.service.call('orch', 'session_read', { sessionId })).length;
    }
    const size = JSON.stringify(await digest(harness)).length;
    expect(size).toBeLessThan(transcripts / 10);
  });
});

describe('owner overview (#20)', () => {
  const dialog = (id, title = 'Pick one') => ({ id, method: 'select', title, options: ['a', 'b'] });

  it('groups every worker under its orchestrator with slots, host, pull request status and pending dialogs, activating nothing', async () => {
    const pending = [];
    const harness = createHarness({ overrides: { listPendingDialogs: () => pending } });
    const { service, deps } = harness;
    harness.add(createRuntime({ sessionId: 'orch-2' }));
    await service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    await service.call('orch-2', 'session_spawn', { cwd: '/work/b', task: 'two' });
    await harness.settle('worker-1', 'first');
    await service.call('worker-1', 'worker_report', { kind: 'question', summary: 'Which API?', audience: 'owner' });
    await service.call('worker-2', 'worker_report', { kind: 'ready', summary: 'PR up', pullRequest: 12 });
    await service.prWatch.apply([{ sessionId: 'worker-2', repository: 'acme/app', number: 12, read: {
      state: 'open', headSha: 'abc1234def', url: 'https://github.com/acme/app/pull/12', comments: 0, checks: { total: 2, pending: 1, state: 'pending' },
    } }]);
    pending.push({ sessionId: 'worker-2', dialog: dialog('d-1') }, { sessionId: 'loose', dialog: dialog('d-2', 'Trust?') });
    deps.activateSession.mockClear();

    const overview = await service.overview();

    expect(deps.activateSession).not.toHaveBeenCalled();
    expect(overview.limit).toEqual({ workerLimit: 4, used: 2 });
    expect(overview.host).toEqual({ load1: 1, cores: 8, availableBytes: 16 * GIB, workers: 2, limit: 4 });
    const byId = Object.fromEntries(overview.orchestrators.map((group) => [group.sessionId, group]));
    // Every marked session is listed, with or without workers.
    expect(Object.keys(byId).sort()).toEqual([...MARKED].sort());
    expect(byId.orch).toMatchObject({ marked: true, title: 'title orch' });
    expect(byId.other).toMatchObject({ marked: true, title: null, workers: [] });
    expect(byId.orch.workers).toEqual([expect.objectContaining({
      sessionId: 'worker-1',
      question: expect.objectContaining({ kind: 'question', audience: 'owner', summary: 'Which API?' }),
      pullRequestStatus: null,
    })]);
    expect(byId['orch-2'].workers).toEqual([expect.objectContaining({
      sessionId: 'worker-2',
      pullRequest: { number: 12, repository: 'acme/app' },
      pullRequestStatus: { status: 'open', url: 'https://github.com/acme/app/pull/12', head: 'abc1234def', checks: { state: 'pending', total: 2, pending: 1 } },
    })]);
    expect(overview.dialogs).toEqual([
      { sessionId: 'worker-2', title: 'title worker-2', directory: '/work/b', orchestratorSessionId: 'orch-2', dialog: dialog('d-1') },
      { sessionId: 'loose', title: null, directory: null, orchestratorSessionId: null, dialog: dialog('d-2', 'Trust?') },
    ]);
  });

  it('names a pending dialog of a worker in the digest (S8)', async () => {
    const pending = [];
    const harness = createHarness({ overrides: { listPendingDialogs: () => pending } });
    await harness.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    const digest = () => harness.service.call('orch', 'orchestration_digest', {});
    expect((await digest()).workers[0].dialog).toBeNull();
    pending.push({ sessionId: 'other-session', dialog: dialog('d-0') }, { sessionId: 'worker-1', dialog: { requestId: 'd-1', method: 'confirm', title: 'Allow push?', message: 'long text' } });
    expect((await digest()).workers[0].dialog).toEqual({ requestId: 'd-1', method: 'confirm', title: 'Allow push?' });
  });

  it('tells the orchestrator to answer with resolves and to leave owner questions and dialogs to the owner (S8)', () => {
    expect(ORCHESTRATION_INSTRUCTIONS).toContain('`resolves` set to its id');
    expect(ORCHESTRATION_INSTRUCTIONS).toContain('Questions with `audience: owner` and pending dialogs belong to the owner');
    expect(ORCHESTRATION_INSTRUCTIONS).toContain('a pending dialog');
  });

  it('keeps an orchestrator whose mark was removed while it still owns workers', async () => {
    let orchestrators = ['orch'];
    const harness = createHarness();
    const readSettings = harness.deps.readSettings;
    const unmarked = createHarness({ file: harness.file, overrides: { readSettings: async () => ({ ...await readSettings(), orchestrators }) } });
    await unmarked.service.call('orch', 'session_spawn', { cwd: '/work/a', task: 'one' });
    orchestrators = [];
    const overview = await unmarked.service.overview();
    expect(overview.orchestrators).toEqual([expect.objectContaining({ sessionId: 'orch', marked: false, workers: [expect.objectContaining({ sessionId: 'worker-1' })] })]);
  });

  it('rejects when the registry or the settings cannot be read, never an empty overview', async () => {
    const broken = Object.assign(new Error('unreadable'), { code: 'ORCHESTRATION_REGISTRY_INVALID' });
    const registryFails = createHarness();
    registryFails.registry.read = async () => { throw broken; };
    await expectCode(registryFails.service.overview(), 'ORCHESTRATION_REGISTRY_INVALID');
    const settingsFail = createHarness({ overrides: { readSettings: async () => { throw broken; } } });
    await expectCode(settingsFail.service.overview(), 'ORCHESTRATION_REGISTRY_INVALID');
  });
});

describe('host gate', () => {
  const spawn = (harness, cwd = '/work/a') => harness.service.call('orch', 'session_spawn', { cwd, task: 'one' });

  it('refuses a spawn on a loaded host with the numbers in the reason and starts nothing', async () => {
    const harness = createHarness();
    harness.host.loadAverage['1m'] = 9.5;
    const error = await spawn(harness).catch((caught) => caught);
    expect(error).toMatchObject({
      code: 'ORCHESTRATION_HOST_BUSY',
      details: { load1: 9.5, cores: 8, availableBytes: 16 * GIB, minAvailableBytes: 8 * GIB },
    });
    expect(error.message).toContain('load 9.50 on 8 cores');
    expect(harness.deps.createWorkerSession).not.toHaveBeenCalled();
    expect(Object.keys((await harness.registry.read()).operations)).toEqual([]);
    harness.host.loadAverage['1m'] = 8;
    await expect(spawn(harness)).resolves.toMatchObject({ sessionId: 'worker-1' });
  });

  it('refuses a spawn when less than the minimum memory is available', async () => {
    const harness = createHarness();
    harness.host.memory.freeBytes = 8 * GIB - 1;
    await expectCode(spawn(harness), 'ORCHESTRATION_HOST_BUSY');
    harness.host.memory.freeBytes = 8 * GIB;
    await expect(spawn(harness)).resolves.toMatchObject({ sessionId: 'worker-1' });
  });

  it('never refuses with the gate switched off', async () => {
    const harness = createHarness({ gate: { enabled: false, minAvailableBytes: 8 * GIB } });
    harness.host.loadAverage['1m'] = 99;
    harness.host.memory.freeBytes = 0;
    await expect(spawn(harness)).resolves.toMatchObject({ sessionId: 'worker-1' });
  });

  it('reports a full limit before a busy host', async () => {
    const harness = createHarness({ workerLimit: 1 });
    await spawn(harness);
    harness.host.loadAverage['1m'] = 99;
    await expectCode(spawn(harness, '/work/b'), 'ORCHESTRATION_LIMIT');
  });

  it('does not gate the retry of a start that is already reserved', async () => {
    const harness = createHarness();
    const args = { cwd: '/work/a', task: 'one', clientRequestId: 'req-1' };
    const first = await harness.service.call('orch', 'session_spawn', args);
    harness.host.loadAverage['1m'] = 99;
    await expect(harness.service.call('orch', 'session_spawn', args)).resolves.toMatchObject({ sessionId: first.sessionId, deduplicated: true });
  });

  it('shows the live host numbers and the slot use in the digest', async () => {
    const harness = createHarness({ workerLimit: 3 });
    await spawn(harness);
    harness.host.loadAverage['1m'] = 2.5;
    harness.host.memory.freeBytes = 5 * GIB;
    const { host } = await harness.service.call('orch', 'orchestration_digest', {});
    expect(host).toEqual({ load1: 2.5, cores: 8, availableBytes: 5 * GIB, workers: 1, limit: 3 });
  });
});

describe('worker_start', () => {
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' }).trim();
  const brief = 'WORKER BRIEF: fix issue 7';
  const args = { clientRequestId: 'start-7', issue: { repo: 'acme/app', number: 7 }, role: 'task-hard', branchName: '7-fix', brief };

  // A repository on `dev` whose `origin` is a bare remote, checked out at
  // <root>/repos/main, so the default worktree root is <root>/repos.
  const setup = (options = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'pichamber-worker-start-'));
    const remote = join(root, 'remote.git');
    const repo = join(root, 'repos', 'main');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '--bare', '-q', '-b', 'dev', remote]);
    git(repo, 'init', '-q', '-b', 'dev');
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'initial');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', 'origin', 'dev');
    const harness = createHarness({ ...options, overrides: { resolveBranch: readGitBranch, ...options.overrides } });
    harness.orchestrator.cwd = repo;
    const branches = () => git(repo, 'branch', '--list', '7-fix').split('\n').filter(Boolean);
    const worktrees = () => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '));
    return { ...harness, root, repo, worktree: join(root, 'repos', '7-fix'), branches, worktrees };
  };

  it('branches from origin/dev, adds the worktree and spawns the worker there; the digest shows issue, branch and worktree', async () => {
    const harness = setup();
    const started = await harness.service.call('orch', 'worker_start', args);

    expect(started).toEqual({ sessionId: 'worker-1', branch: '7-fix', worktree: harness.worktree });
    expect(git(harness.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('7-fix');
    expect(git(harness.repo, 'rev-parse', '7-fix')).toBe(git(harness.repo, 'rev-parse', 'origin/dev'));
    expect(harness.deps.createWorkerSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: harness.worktree, thinking: 'high' }));
    expect(harness.deps.sendInput.mock.calls[0][0].text.endsWith(brief)).toBe(true);
    expect((await harness.workers())['worker-1']).toMatchObject({ issue: { repo: 'acme/app', number: 7 }, branch: '7-fix', cwd: harness.worktree, role: 'task-hard' });

    const { workers } = await harness.service.call('orch', 'orchestration_digest', {});
    expect(workers[0]).toMatchObject({ sessionId: 'worker-1', issue: { repo: 'acme/app', number: 7 }, branch: '7-fix', worktree: harness.worktree });
  });

  it('starts the worker with the requested tool profile and rejects an unknown one (#151)', async () => {
    const harness = setup();
    await expectCode(harness.service.call('orch', 'worker_start', { ...args, profile: 'sandbox' }), 'INVALID_ARGUMENT');
    await harness.service.call('orch', 'worker_start', { ...args, profile: 'read-only' });
    expect(harness.deps.createWorkerSession).toHaveBeenCalledTimes(1);
    expect(harness.deps.createWorkerSession.mock.calls[0][0].lineage.profile).toMatchObject({ name: 'read-only', excludeTools: expect.arrayContaining(['edit', 'write']) });
    expect((await harness.workers())['worker-1'].profile.name).toBe('read-only');
  });

  it('continues after a failed worktree step: one branch, one worktree, one worker', async () => {
    const harness = setup();
    mkdirSync(harness.worktree, { recursive: true });
    writeFileSync(join(harness.worktree, 'in-the-way'), 'x');

    const failed = harness.service.call('orch', 'worker_start', args);
    await expect(failed).rejects.toMatchObject({ code: 'WORKER_START_FAILED', details: { step: 'worktree' } });
    await expect(failed).rejects.toThrow(/already exists/);
    expect(harness.branches()).toHaveLength(1);
    expect(harness.worktrees()).toHaveLength(1);
    expect(await harness.workers()).toEqual({});

    rmSync(harness.worktree, { recursive: true });
    await expect(harness.service.call('orch', 'worker_start', args)).resolves.toMatchObject({ sessionId: 'worker-1', worktree: harness.worktree });
    expect(harness.branches()).toHaveLength(1);
    expect(harness.worktrees()).toHaveLength(2);
    expect(Object.keys(await harness.workers())).toEqual(['worker-1']);
  });

  it('continues after a failed spawn: the worktree is reused and one worker starts', async () => {
    const harness = setup();
    harness.deps.createWorkerSession.mockRejectedValueOnce(new Error('session store unavailable'));

    await expect(harness.service.call('orch', 'worker_start', args)).rejects.toThrow(/session store unavailable/);
    expect(harness.worktrees()).toHaveLength(2);
    expect(await harness.workers()).toEqual({});

    // The worktree may already hold the worker's commits; it is still reused.
    writeFileSync(join(harness.worktree, 'work.txt'), 'progress\n');
    git(harness.worktree, 'add', '.');
    git(harness.worktree, 'commit', '-q', '-m', 'work');
    await expect(harness.service.call('orch', 'worker_start', args)).resolves.toMatchObject({ branch: '7-fix', worktree: harness.worktree });
    expect(harness.branches()).toHaveLength(1);
    expect(harness.worktrees()).toHaveLength(2);
    expect(Object.keys(await harness.workers())).toHaveLength(1);
  });

  it('refuses an existing branch that moved away from origin/dev and creates nothing', async () => {
    const harness = setup();
    git(harness.repo, 'switch', '-q', '-c', '7-fix');
    writeFileSync(join(harness.repo, 'other.txt'), 'other\n');
    git(harness.repo, 'add', '.');
    git(harness.repo, 'commit', '-q', '-m', 'foreign');
    git(harness.repo, 'switch', '-q', 'dev');

    const refused = harness.service.call('orch', 'worker_start', args);
    await expect(refused).rejects.toMatchObject({ code: 'WORKER_START_FAILED', details: { step: 'branch' } });
    await expect(refused).rejects.toThrow(/does not point at origin\/dev/);
    expect(harness.worktrees()).toHaveLength(1);
    expect(await harness.workers()).toEqual({});
    expect(harness.deps.createWorkerSession).not.toHaveBeenCalled();
  });

  it('places the worktree under the configured root and is for orchestrators only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pichamber-worktree-root-'));
    const harness = setup({ overrides: { readSettings: async () => ({ workerLimit: 4, gate: { enabled: true, minAvailableBytes: 8 * GIB }, roles: ROLES, worktreeRoot: root, orchestrators: ['orch'] }) } });
    await expect(harness.service.call('orch', 'worker_start', args)).resolves.toMatchObject({ worktree: join(root, '7-fix') });
    await expectCode(harness.service.call('worker-1', 'worker_start', { ...args, clientRequestId: 'start-8', branchName: '8-fix' }), 'ORCHESTRATION_FORBIDDEN');
  });
});

describe('worker_cleanup', () => {
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' }).trim();
  const MERGED_AT = '2026-10-13T12:00:00Z';

  // A github.com repository on `dev` (origin rewritten to a bare remote) and
  // a worker worktree on 9-fix with one pushed commit; the owner squash
  // merged it into dev, so `git branch -d` would refuse.
  const setup = async ({ pr = 'merged', overrides = {} } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'pichamber-worker-cleanup-'));
    const remote = join(root, 'remote.git');
    const repo = join(root, 'repos', 'main');
    const worktree = join(root, 'repos', '9-fix');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '--bare', '-q', '-b', 'dev', remote]);
    git(repo, 'init', '-q', '-b', 'dev');
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'initial');
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
    git(repo, 'config', `url.${remote}.insteadOf`, 'git@github.com:acme/app.git');
    git(repo, 'push', '-q', 'origin', 'dev');
    git(repo, 'worktree', 'add', '-q', '-b', '9-fix', worktree);
    writeFileSync(join(worktree, 'fix.txt'), 'fix\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-q', '-m', 'fix');
    git(worktree, 'push', '-q', 'origin', '9-fix');
    const headSha = git(worktree, 'rev-parse', 'HEAD');
    git(repo, 'merge', '-q', '--squash', '9-fix');
    git(repo, 'commit', '-q', '-m', 'fix (#5)');
    git(repo, 'push', '-q', 'origin', 'dev');
    const read = { number: 5, state: pr, mergedAt: pr === 'merged' ? MERGED_AT : null, headSha, url: '' };
    const pullLookup = { pullForBranch: vi.fn(async () => read), pullByNumber: vi.fn(async () => read) };
    const deleteSession = vi.fn(async () => {});
    const harness = createHarness({ overrides: { pullLookup, deleteSession, ...overrides } });
    harness.orchestrator.cwd = repo;
    const { sessionId } = await harness.service.call('orch', 'session_spawn', { cwd: worktree, task: 'fix 9' });
    await harness.settle(sessionId, 'done');
    const branchExists = () => git(repo, 'branch', '--list', '9-fix') !== '';
    const remoteExists = () => git(repo, 'ls-remote', '--heads', 'origin', 'refs/heads/9-fix') !== '';
    const cleanup = () => harness.service.call('orch', 'worker_cleanup', { sessionId });
    return { ...harness, root, remote, repo, worktree, headSha, read, pullLookup, deleteSession, sessionId, branchExists, remoteExists, cleanup };
  };

  it('removes worktree, local and remote branch, then the session, and forgets the worker after a squash merge', async () => {
    const h = await setup();
    const result = await h.cleanup();

    expect(result).toEqual({ sessionId: h.sessionId, removed: [`worktree ${h.worktree}`, 'branch 9-fix', 'origin 9-fix', `session ${h.sessionId}`] });
    expect(h.pullLookup.pullForBranch).toHaveBeenCalledWith({ repository: 'acme/app', branch: '9-fix' });
    expect(existsSync(h.worktree)).toBe(false);
    expect(h.branchExists()).toBe(false);
    expect(h.remoteExists()).toBe(false);
    expect(h.deleteSession).toHaveBeenCalledWith(h.sessionId);
    expect(await h.workers()).toEqual({});
  });

  it.each([
    ['an open pull request', { pr: 'open' }, () => {}, /still open/],
    ['a closed unmerged pull request', { pr: 'closed' }, () => {}, /ask the owner/],
    ['a commit after the merged head', {}, (h) => { writeFileSync(join(h.worktree, 'more.txt'), 'x\n'); git(h.worktree, 'add', '.'); git(h.worktree, 'commit', '-q', '-m', 'more'); }, /not at the merged head/],
    ['a dirty worktree', {}, (h) => writeFileSync(join(h.worktree, 'scratch.txt'), 'x\n'), /uncommitted/],
    ['a live run', {}, (h) => h.states.set(h.sessionId, 'busy'), /running or waiting/],
    ['a failed lookup', {}, (h) => h.pullLookup.pullForBranch.mockRejectedValueOnce(new Error('gh auth missing')), /lookup failed: gh auth missing/],
  ])('refuses %s and removes nothing', async (_name, options, arrange, reason) => {
    const h = await setup(options);
    arrange(h);
    const result = await h.cleanup();

    expect(result).toMatchObject({ removed: [], reason: expect.stringMatching(reason) });
    expect(existsSync(h.worktree)).toBe(true);
    expect(h.branchExists()).toBe(true);
    expect(h.remoteExists()).toBe(true);
    expect(h.deleteSession).not.toHaveBeenCalled();
    expect(Object.keys(await h.workers())).toEqual([h.sessionId]);
  });

  it('names the failed step and continues on the next call', async () => {
    const h = await setup();
    git(h.repo, 'config', '--unset', `url.${h.remote}.insteadOf`);
    git(h.repo, 'config', `url.${join(h.root, 'missing.git')}.insteadOf`, 'git@github.com:acme/app.git');

    await expect(h.cleanup()).rejects.toMatchObject({ code: 'WORKER_CLEANUP_FAILED', details: { step: 'remote', removed: [`worktree ${h.worktree}`, 'branch 9-fix'] } });
    expect(Object.keys(await h.workers())).toEqual([h.sessionId]);

    git(h.repo, 'config', '--unset', `url.${join(h.root, 'missing.git')}.insteadOf`);
    git(h.repo, 'config', `url.${h.remote}.insteadOf`, 'git@github.com:acme/app.git');
    await expect(h.cleanup()).resolves.toEqual({ sessionId: h.sessionId, removed: ['origin 9-fix', `session ${h.sessionId}`] });
    expect(h.remoteExists()).toBe(false);
    expect(await h.workers()).toEqual({});
  });

  it('leaves a remote branch that moved after the merge (lease)', async () => {
    const h = await setup();
    const other = join(h.root, 'other');
    execFileSync('git', ['clone', '-q', '-b', '9-fix', h.remote, other]);
    writeFileSync(join(other, 'late.txt'), 'late\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'late');
    git(other, 'push', '-q', 'origin', '9-fix');

    await expect(h.cleanup()).rejects.toMatchObject({ code: 'WORKER_CLEANUP_FAILED', details: { step: 'remote' } });
    expect(h.remoteExists()).toBe(true);
  });

  it('refuses the main checkout of a repository', async () => {
    const h = await setup();
    await h.registry.update((document) => { document.workers[h.sessionId].cwd = h.repo; });
    const result = await h.cleanup();
    expect(result).toMatchObject({ removed: [], reason: expect.stringMatching(/main checkout/) });
    expect(h.deleteSession).not.toHaveBeenCalled();
  });

  it('deletes only the session of a helper bound by servesPr once its pull request is merged', async () => {
    const read = { number: 5, state: 'open', mergedAt: null, headSha: 'a'.repeat(40), url: '' };
    const pullLookup = { pullForBranch: vi.fn(), pullByNumber: vi.fn(async () => read) };
    const deleteSession = vi.fn(async () => {});
    const harness = createHarness({ overrides: { pullLookup, deleteSession } });
    const { sessionId } = await harness.service.call('orch', 'session_spawn', { cwd: '/work/review', task: 'review PR 5', servesPr: { repo: 'acme/app', number: 5 } });
    await harness.settle(sessionId, 'done');
    expect((await harness.workers())[sessionId].servesPr).toEqual({ repo: 'acme/app', number: 5 });

    await expect(harness.service.call('orch', 'worker_cleanup', { sessionId })).resolves.toMatchObject({ removed: [], reason: expect.stringMatching(/still open/) });
    Object.assign(read, { state: 'merged', mergedAt: MERGED_AT });
    await expect(harness.service.call('orch', 'worker_cleanup', { sessionId })).resolves.toEqual({ sessionId, removed: [`session ${sessionId}`] });
    expect(pullLookup.pullByNumber).toHaveBeenCalledWith({ repository: 'acme/app', number: 5 });
    expect(await harness.workers()).toEqual({});
  });

  it('skips a remote branch the owner already deleted', async () => {
    const h = await setup();
    git(h.repo, 'push', '-q', 'origin', '--delete', '9-fix');
    await expect(h.cleanup()).resolves.toEqual({ sessionId: h.sessionId, removed: [`worktree ${h.worktree}`, 'branch 9-fix', `session ${h.sessionId}`] });
  });

  it('refuses a helper without servesPr and without a worktree', async () => {
    const deleteSession = vi.fn(async () => {});
    const harness = createHarness({ overrides: { pullLookup: { pullForBranch: vi.fn(), pullByNumber: vi.fn() }, deleteSession } });
    const scratch = mkdtempSync(join(tmpdir(), 'pichamber-helper-'));
    const { sessionId } = await harness.service.call('orch', 'session_spawn', { cwd: scratch, task: 'research' });
    await harness.settle(sessionId, 'done');
    await expect(harness.service.call('orch', 'worker_cleanup', { sessionId })).resolves.toMatchObject({ removed: [], reason: expect.stringMatching(/no git worktree[\s\S]*servesPr/) });
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('refuses new input while it runs and frees the worker after a refusal', async () => {
    const h = await setup();
    let release;
    h.pullLookup.pullForBranch.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(h.read); }));
    const running = h.cleanup();
    await vi.waitFor(() => expect(release).toBeDefined());

    await expectCode(h.input(h.sessionId), 'ORCHESTRATION_WORKER_STOPPING');
    release();
    await expect(running).resolves.toMatchObject({ removed: [`worktree ${h.worktree}`, 'branch 9-fix', 'origin 9-fix', `session ${h.sessionId}`] });

    const open = await setup({ pr: 'open' });
    await expect(open.cleanup()).resolves.toMatchObject({ removed: [] });
    expect((await open.workers())[open.sessionId].stopping).toBeUndefined();
    await expect(open.input(open.sessionId)).resolves.toMatchObject({ accepted: true });
  });

  it('refuses while an input admitted before it is still deciding, and removes nothing', async () => {
    const h = await setup();
    let decide;
    const deciding = new Promise((resolve) => { decide = resolve; });
    let admitted;
    const admittedNow = new Promise((resolve) => { admitted = resolve; });
    // Admitted before the claim; Pi's verdict is still out.
    const input = h.input(h.sessionId, { beforeVerdict: () => { admitted(); return deciding; } });
    await admittedNow;

    await expect(h.cleanup()).resolves.toMatchObject({ removed: [], reason: expect.stringMatching(/running or waiting/) });
    expect(existsSync(h.worktree)).toBe(true);
    expect(h.branchExists()).toBe(true);
    expect(h.remoteExists()).toBe(true);
    expect(h.deleteSession).not.toHaveBeenCalled();
    decide();
    await input;
  });

  it.each(['worktree', 'servesPr'])('refuses a %s worker whose stop left a hold for an unsettled input, and removes nothing', async (kind) => {
    const read = { number: 5, state: 'merged', mergedAt: MERGED_AT, headSha: 'a'.repeat(40), url: '' };
    const h = kind === 'worktree'
      ? await setup()
      : await (async () => {
        const harness = createHarness({ overrides: { pullLookup: { pullForBranch: vi.fn(), pullByNumber: vi.fn(async () => read) }, deleteSession: vi.fn(async () => {}) } });
        const { sessionId } = await harness.service.call('orch', 'session_spawn', { cwd: '/work/review', task: 'review PR 5', servesPr: { repo: 'acme/app', number: 5 } });
        await harness.settle(sessionId, 'done');
        return { ...harness, sessionId, deleteSession: harness.deps.deleteSession, cleanup: () => harness.service.call('orch', 'worker_cleanup', { sessionId }) };
      })();
    // Pi accepted an input the stop could not settle; the live fields are idle.
    await h.input(h.sessionId, { outcome: 'unresolved' });
    await h.service.call('orch', 'session_stop', { sessionId: h.sessionId });
    expect((await h.workers())[h.sessionId]).toMatchObject({ state: 'stopped', hold: { reason: 'unresolved_input' } });

    await expect(h.cleanup()).resolves.toMatchObject({ removed: [], reason: expect.stringMatching(/unsettled input/) });
    if (kind === 'worktree') {
      expect(existsSync(h.worktree)).toBe(true);
      expect(h.branchExists()).toBe(true);
      expect(h.remoteExists()).toBe(true);
    }
    expect(h.deleteSession).not.toHaveBeenCalled();
    expect((await h.workers())[h.sessionId]).toMatchObject({ hold: { reason: 'unresolved_input' } });
    expect((await h.workers())[h.sessionId].stopping).toBeUndefined();
  });

  it('refuses a worker it cannot prove idle here, such as one resident in another daemon', async () => {
    const h = await setup();
    h.runtimes.delete(h.sessionId);
    h.deps.activateSession.mockRejectedValueOnce(Object.assign(new Error('in use'), { code: 'SESSION_IN_USE' }));

    await expect(h.cleanup()).resolves.toMatchObject({ removed: [], reason: expect.stringMatching(/another PiChamber instance/) });
    expect(existsSync(h.worktree)).toBe(true);
    expect(h.branchExists()).toBe(true);
    expect(h.deleteSession).not.toHaveBeenCalled();
    expect(h.pullLookup.pullForBranch).not.toHaveBeenCalled();
  });

  it('refuses a servesPr helper it cannot prove idle here', async () => {
    const read = { number: 5, state: 'merged', mergedAt: MERGED_AT, headSha: 'a'.repeat(40), url: '' };
    const deleteSession = vi.fn(async () => {});
    const harness = createHarness({ overrides: { pullLookup: { pullForBranch: vi.fn(), pullByNumber: vi.fn(async () => read) }, deleteSession } });
    const { sessionId } = await harness.service.call('orch', 'session_spawn', { cwd: '/work/review', task: 'review PR 5', servesPr: { repo: 'acme/app', number: 5 } });
    await harness.settle(sessionId, 'done');
    harness.runtimes.delete(sessionId);
    harness.deps.activateSession.mockRejectedValueOnce(Object.assign(new Error('in use'), { code: 'SESSION_IN_USE' }));

    await expect(harness.service.call('orch', 'worker_cleanup', { sessionId })).resolves.toMatchObject({ removed: [], reason: expect.stringMatching(/another PiChamber instance/) });
    harness.states.set(sessionId, 'busy');
    harness.runtimes.set(sessionId, createRuntime({ sessionId }));
    await expect(harness.service.call('orch', 'worker_cleanup', { sessionId })).resolves.toMatchObject({ removed: [], reason: expect.stringMatching(/running or waiting/) });
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it.each([
    ['a detached commit', (h) => { git(h.worktree, 'checkout', '-q', '--detach'); }, /detached HEAD/],
    ['another branch after the old one is gone', (h) => { git(h.worktree, 'checkout', '-q', '-b', '10-next'); git(h.repo, 'branch', '-D', '9-fix'); }, /holds 10-next/],
  ])('on a retry leaves a worktree that now holds %s', async (_name, reuse, reason) => {
    const h = await setup();
    git(h.repo, 'worktree', 'lock', h.worktree);
    await expect(h.cleanup()).rejects.toMatchObject({ code: 'WORKER_CLEANUP_FAILED', details: { step: 'worktree', removed: [] } });

    git(h.repo, 'worktree', 'unlock', h.worktree);
    reuse(h);
    writeFileSync(join(h.worktree, 'next.txt'), 'next\n');
    git(h.worktree, 'add', '.');
    git(h.worktree, 'commit', '-q', '-m', 'next');
    const head = git(h.worktree, 'rev-parse', 'HEAD');

    await expect(h.cleanup()).resolves.toMatchObject({ removed: [], reason: expect.stringMatching(reason) });
    expect(git(h.worktree, 'rev-parse', 'HEAD')).toBe(head);
    expect(h.deleteSession).not.toHaveBeenCalled();
    expect(Object.keys(await h.workers())).toEqual([h.sessionId]);
  });

  it('is the owning orchestrator\'s tool only', async () => {
    const h = await setup();
    await expectCode(h.service.call(h.sessionId, 'worker_cleanup', { sessionId: h.sessionId }), 'ORCHESTRATION_FORBIDDEN');
    h.runtimes.set('other-orch', createRuntime({ sessionId: 'other-orch' }));
    await expectCode(h.service.call('other-orch', 'worker_cleanup', { sessionId: h.sessionId }), 'ORCHESTRATION_FORBIDDEN');
    expect(existsSync(h.worktree)).toBe(true);
  });
});
