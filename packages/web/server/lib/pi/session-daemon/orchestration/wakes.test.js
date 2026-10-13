import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWakes, EVENTS_MESSAGE } from './wakes.js';

const MINUTE = 60_000;

const createHarness = ({ settings = {} } = {}) => {
  const document = {
    workers: {
      'worker-1': { orchestratorSessionId: 'orch', title: 'Fix login', state: 'active' },
      'worker-2': { orchestratorSessionId: 'orch', title: 'Docs', state: 'active' },
      'worker-3': { orchestratorSessionId: 'orch', title: 'Tests', state: 'active' },
    },
    owners: { orch: { cwd: '/repo' }, successor: { cwd: '/other' } },
  };
  const states = new Map();
  const dialogs = new Set();
  const runtimes = new Map();
  const addOwner = (sessionId) => {
    const runtime = {
      sent: [],
      session: { sendCustomMessage: vi.fn(async (message, options) => { runtime.sent.push({ message, options }); }) },
    };
    runtimes.set(sessionId, runtime);
    return runtime;
  };
  const orch = addOwner('orch');
  let clock = 1_000_000;
  const held = [];
  const deps = {
    registry: { read: vi.fn(async () => structuredClone(document)) },
    getLiveRuntime: (sessionId) => runtimes.get(sessionId),
    activateSession: vi.fn(async (sessionId) => {
      const runtime = runtimes.get(sessionId) ?? addOwner(sessionId);
      return runtime;
    }),
    holdSession: (sessionId) => { held.push(sessionId); return () => {}; },
    stateOf: (sessionId) => states.get(sessionId) ?? (runtimes.has(sessionId) ? 'idle' : 'dormant'),
    runStartedAt: () => undefined,
    waitingForInput: (sessionId) => dialogs.has(sessionId),
    readSettings: async () => ({ wakes: { coalesceMs: 3_000 }, watchdog: { stallAfterMs: 10 * MINUTE, enabled: true }, ...settings }),
    now: () => clock,
    isGone: (error) => error?.code === 'SESSION_NOT_FOUND',
  };
  const wakes = createWakes(deps);
  const advance = async (ms) => {
    clock += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  return { wakes, deps, document, states, dialogs, runtimes, orch, addOwner, advance, held };
};

const lines = (entry) => entry.message.content.split('\n');

describe('orchestration wakes', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('wakes an idle owner once after the coalescing window with one line per event', async () => {
    const { wakes, orch, advance, held } = createHarness();
    wakes.emit('worker-1', 'run_finished', 'Opened PR #12.\nAll tests pass.');
    await advance(2_999);
    expect(orch.sent).toHaveLength(0);
    await advance(1);
    expect(orch.sent).toHaveLength(1);
    const [entry] = orch.sent;
    expect(entry.message).toMatchObject({ customType: EVENTS_MESSAGE, display: true });
    expect(entry.options).toEqual({ triggerTurn: true, deliverAs: 'followUp' });
    expect(lines(entry)).toEqual([
      'A worker event:',
      '- "Fix login" (worker-1) run_finished: Opened PR #12. All tests pass.',
      'Read `mcp__pichamber__orchestration_digest` for details.',
    ]);
    expect(entry.message.details.events).toEqual([
      { sessionId: 'worker-1', kind: 'run_finished', reason: 'Opened PR #12. All tests pass.', at: 1_000_000 },
    ]);
    expect(held).toEqual(['orch']);
    await advance(60_000);
    expect(orch.sent).toHaveLength(1);
  });

  it('limits a reason to one line of 200 characters', async () => {
    const { wakes, orch, advance } = createHarness();
    wakes.emit('worker-1', 'run_failed', `${'x'.repeat(300)}\nsecond`);
    await advance(3_000);
    expect(orch.sent[0].message.details.events[0].reason).toHaveLength(200);
  });

  it('sends a burst as one message', async () => {
    const { wakes, orch, advance } = createHarness();
    wakes.emit('worker-1', 'run_finished', 'one');
    await advance(1_000);
    wakes.emit('worker-2', 'question', 'two');
    wakes.emit('worker-3', 'run_failed', 'three');
    await advance(2_000);
    expect(orch.sent).toHaveLength(1);
    expect(lines(orch.sent[0])).toHaveLength(5);
    expect(orch.sent[0].message.details.events.map((event) => event.kind)).toEqual(['run_finished', 'question', 'run_failed']);
  });

  it('keeps the window when a worker settles or the watchdog ticks before it ends', async () => {
    const { wakes, orch, advance } = createHarness();
    wakes.emit('worker-1', 'question', 'which branch?');
    await advance(1_000);
    wakes.settled('worker-1');
    wakes.settled('someone-else');
    await vi.advanceTimersByTimeAsync(0);
    wakes.emit('worker-1', 'run_finished', 'asked the owner');
    await advance(1_500);
    await wakes.tick();
    expect(orch.sent).toHaveLength(0);
    await advance(500);
    expect(orch.sent).toHaveLength(1);
    expect(orch.sent[0].message.details.events.map((event) => event.kind)).toEqual(['question', 'run_finished']);
  });

  it('keeps events for a busy owner until it settles', async () => {
    const { wakes, orch, advance, states } = createHarness();
    states.set('orch', 'busy');
    wakes.emit('worker-1', 'run_finished', 'one');
    wakes.emit('worker-2', 'run_finished', 'two');
    await advance(30_000);
    expect(orch.sent).toHaveLength(0);
    states.set('orch', 'idle');
    wakes.settled('orch');
    await vi.advanceTimersByTimeAsync(0);
    expect(orch.sent).toHaveLength(1);
    expect(orch.sent[0].message.details.events).toHaveLength(2);
  });

  it('delivers an event emitted during a pending send in the next message', async () => {
    const { wakes, orch, advance } = createHarness();
    let finish;
    orch.session.sendCustomMessage.mockImplementationOnce(async (message, options) => {
      orch.sent.push({ message, options });
      await new Promise((resolve) => { finish = resolve; });
    });
    wakes.emit('worker-1', 'run_finished', 'one');
    await advance(3_000);
    expect(orch.sent).toHaveLength(1);
    wakes.emit('worker-2', 'question', 'two');
    await advance(3_000);
    expect(orch.sent).toHaveLength(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(orch.sent).toHaveLength(2);
    expect(orch.sent[1].message.details.events.map((event) => event.sessionId)).toEqual(['worker-2']);
  });

  it('reads the owner at send time, so a takeover delivers to the new owner', async () => {
    const { wakes, orch, advance, document, addOwner } = createHarness();
    const successor = addOwner('successor');
    wakes.emit('worker-1', 'question', 'which branch?');
    document.workers['worker-1'].orchestratorSessionId = 'successor';
    await advance(3_000);
    expect(orch.sent).toHaveLength(0);
    expect(successor.sent).toHaveLength(1);
  });

  it('reopens a dormant owner and keeps the queue while its session is in use', async () => {
    const { wakes, deps, advance, runtimes } = createHarness();
    runtimes.delete('orch');
    deps.activateSession.mockRejectedValueOnce(Object.assign(new Error('in use'), { code: 'SESSION_IN_USE' }));
    wakes.emit('worker-1', 'run_finished', 'one');
    await advance(3_000);
    expect(deps.activateSession).toHaveBeenCalledWith('orch', '/repo');
    expect(deps.activateSession).toHaveBeenCalledTimes(1);
    await wakes.tick();
    expect(deps.activateSession).toHaveBeenCalledTimes(2);
    expect(runtimes.get('orch').sent.map((entry) => entry.message.details.events.length)).toEqual([1]);
  });

  it('drops events for a deleted owner and for stopped workers', async () => {
    const { wakes, deps, advance, runtimes } = createHarness();
    runtimes.delete('orch');
    deps.activateSession.mockRejectedValue(Object.assign(new Error('gone'), { code: 'SESSION_NOT_FOUND' }));
    wakes.emit('worker-1', 'run_finished', 'one');
    await advance(3_000);
    await wakes.tick();
    expect(deps.activateSession).toHaveBeenCalledTimes(1);

    const orch = createHarness();
    orch.document.workers['worker-1'].state = 'stopped';
    orch.wakes.emit('worker-1', 'run_finished', 'one');
    await orch.advance(3_000);
    expect(orch.orch.sent).toHaveLength(0);
  });

  it('reports a worker busy without progress as stalled once per episode', async () => {
    const { wakes, orch, advance, states } = createHarness();
    states.set('worker-1', 'busy');
    await wakes.tick();
    await advance(9 * MINUTE);
    wakes.touch('worker-1');
    await advance(9 * MINUTE);
    await wakes.tick();
    expect(orch.sent).toHaveLength(0);
    await advance(MINUTE);
    await wakes.tick();
    await advance(3_000);
    expect(orch.sent).toHaveLength(1);
    expect(orch.sent[0].message.details.events).toMatchObject([{ sessionId: 'worker-1', kind: 'stalled' }]);
    await advance(20 * MINUTE);
    await wakes.tick();
    await advance(3_000);
    expect(orch.sent).toHaveLength(1);
    // Progress starts a new episode.
    wakes.touch('worker-1');
    await advance(10 * MINUTE);
    await wakes.tick();
    await advance(3_000);
    expect(orch.sent).toHaveLength(2);
  });

  it('reports no stall while a worker waits on a dialog and counts quiet time again after the answer', async () => {
    const { wakes, orch, advance, states, dialogs } = createHarness();
    states.set('worker-1', 'busy');
    dialogs.add('worker-1');
    await wakes.tick();
    await advance(30 * MINUTE);
    await wakes.tick();
    await advance(3_000);
    expect(orch.sent).toHaveLength(0);
    dialogs.delete('worker-1');
    await advance(9 * MINUTE);
    await wakes.tick();
    await advance(3_000);
    expect(orch.sent).toHaveLength(0);
    await advance(MINUTE);
    await wakes.tick();
    await advance(3_000);
    expect(orch.sent).toHaveLength(1);
    expect(orch.sent[0].message.details.events).toMatchObject([{ sessionId: 'worker-1', kind: 'stalled' }]);
  });

  it('reports no stall when the watchdog is off or the worker is idle', async () => {
    const off = createHarness({ settings: { watchdog: { stallAfterMs: MINUTE, enabled: false } } });
    off.states.set('worker-1', 'busy');
    await off.wakes.tick();
    await off.advance(5 * MINUTE);
    await off.wakes.tick();
    await off.advance(3_000);
    expect(off.orch.sent).toHaveLength(0);

    const idle = createHarness();
    await idle.wakes.tick();
    await idle.advance(30 * MINUTE);
    await idle.wakes.tick();
    await idle.advance(3_000);
    expect(idle.orch.sent).toHaveLength(0);
  });

  it('runs the watchdog every 15 seconds between start and stop', async () => {
    const { wakes, deps, advance } = createHarness();
    wakes.start();
    await advance(15_000);
    expect(deps.registry.read).toHaveBeenCalledTimes(1);
    wakes.stop();
    await advance(60_000);
    expect(deps.registry.read).toHaveBeenCalledTimes(1);
  });
});
