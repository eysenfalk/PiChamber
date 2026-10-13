import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrWatch, diffPullRequest } from './pr-watch.js';
import { createWakes } from './wakes.js';

const green = { total: 3, pending: 0, state: 'success' };
const red = { total: 3, pending: 0, state: 'failure' };
const running = { total: 3, pending: 1, state: 'pending' };
const read = (overrides = {}) => ({
  number: 7, state: 'open', headSha: 'aaaaaaa1111', url: 'https://github.com/o/r/pull/7', comments: 0, checks: running, ...overrides,
});
const kinds = (result) => result.events.map((event) => event.kind);

describe('diffPullRequest', () => {
  it('reports a final green result once, with the link', () => {
    const first = diffPullRequest(undefined, read({ checks: green }));
    expect(kinds(first)).toEqual(['ci_passed']);
    expect(first.events[0].reason).toContain('https://github.com/o/r/pull/7');
    expect(kinds(diffPullRequest(first.state, read({ checks: green })))).toEqual([]);
  });

  it('reports a final red result and stays quiet while checks run', () => {
    const waiting = diffPullRequest(undefined, read({ checks: running }));
    expect(waiting.events).toEqual([]);
    expect(kinds(diffPullRequest(waiting.state, read({ checks: red })))).toEqual(['ci_failed']);
    expect(kinds(diffPullRequest(undefined, read({ checks: { total: 0, pending: 0, state: 'unknown' } })))).toEqual([]);
  });

  it('reports the next result after a new head commit', () => {
    const passed = diffPullRequest(undefined, read({ checks: green }));
    const pushed = diffPullRequest(passed.state, read({ headSha: 'bbbbbbb2222', checks: running }));
    expect(pushed.events).toEqual([]);
    expect(kinds(diffPullRequest(pushed.state, read({ headSha: 'bbbbbbb2222', checks: red })))).toEqual(['ci_failed']);
  });

  it('reports two new comments as one event and ignores comments seen at the start', () => {
    const seeded = diffPullRequest(undefined, read({ comments: 3 }));
    expect(seeded.events).toEqual([]);
    const more = diffPullRequest(seeded.state, read({ comments: 5 }));
    expect(kinds(more)).toEqual(['review_activity']);
    expect(more.events[0].reason).toContain('2 new comments');
    expect(diffPullRequest(more.state, read({ comments: 5 })).events).toEqual([]);
  });

  it('reports a merge or a close once', () => {
    const open = diffPullRequest(undefined, read());
    const merged = diffPullRequest(open.state, read({ state: 'merged', checks: green }));
    expect(kinds(merged)).toEqual(['pr_merged']);
    expect(diffPullRequest(merged.state, read({ state: 'merged' })).events).toEqual([]);
    expect(kinds(diffPullRequest(open.state, read({ state: 'closed' })))).toEqual(['pr_closed']);
  });

  it('keeps state and emits nothing for a stale, partial or missing read', () => {
    const waiting = diffPullRequest(undefined, read({ comments: 1 }));
    for (const bad of [read({ checks: green, comments: 4, incomplete: true }), null]) {
      const result = diffPullRequest(waiting.state, bad);
      expect(result).toEqual({ state: waiting.state, events: [] });
    }
    // The same data arriving complete still counts afterwards.
    expect(kinds(diffPullRequest(waiting.state, read({ checks: green, comments: 4 })))).toEqual(['ci_passed', 'review_activity']);
  });

  it('after a restart reports an already final result and a merge once, but not old comments', () => {
    expect(kinds(diffPullRequest(undefined, read({ checks: green, comments: 9 })))).toEqual(['ci_passed']);
    expect(kinds(diffPullRequest(undefined, read({ state: 'merged', comments: 9 })))).toEqual(['pr_merged']);
  });
});

describe('createPrWatch', () => {
  const workers = () => ({
    w1: { cwd: '/wt/a', state: 'active', orchestratorSessionId: 'orch', title: 'A', pullRequest: { number: 7, repository: 'o/r' } },
    w2: { cwd: '/wt/b', state: 'active', orchestratorSessionId: 'orch', title: 'B' },
    w3: { cwd: '/wt/c', state: 'stopped', orchestratorSessionId: 'orch', title: 'C', pullRequest: { number: 8, repository: 'o/r' } },
  });
  const setup = (settings = { github: { enabled: true } }) => {
    const document = { workers: workers(), owners: { orch: { cwd: '/repo' } } };
    const emit = vi.fn();
    const watch = createPrWatch({ registry: { read: async () => structuredClone(document) }, emit, readSettings: async () => settings });
    return { document, emit, watch };
  };

  it('targets only live workers with a pull request, and none when the setting is off', async () => {
    expect(await setup().watch.targets()).toEqual([{ sessionId: 'w1', directory: '/wt/a', number: 7, repository: 'o/r' }]);
    expect(await setup({ github: { enabled: false } }).watch.targets()).toEqual([]);
  });

  it('emits events of an applied read and stops targeting a merged pull request', async () => {
    const { watch, emit } = setup();
    await watch.apply([{ sessionId: 'w1', repository: 'o/r', number: 7, read: read({ checks: green }) }]);
    expect(emit).toHaveBeenCalledWith('w1', 'ci_passed', expect.stringContaining('PR #7'));
    await watch.apply([{ sessionId: 'w1', repository: 'o/r', number: 7, read: read({ state: 'merged' }) }]);
    expect(emit).toHaveBeenLastCalledWith('w1', 'pr_merged', expect.any(String));
    expect(await watch.targets()).toEqual([]);
  });

  it('drops a read for a pull request the worker no longer has', async () => {
    const { watch, emit } = setup();
    await watch.apply([{ sessionId: 'w1', repository: 'o/r', number: 99, read: read({ checks: green, number: 99 }) }]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('watches a new pull request of the same worker after the old one was merged', async () => {
    const { watch, emit, document } = setup();
    await watch.apply([{ sessionId: 'w1', repository: 'o/r', number: 7, read: read({ state: 'merged' }) }]);
    expect(await watch.targets()).toEqual([]);
    document.workers.w1.pullRequest = { number: 9, repository: 'o/r' };
    expect(await watch.targets()).toEqual([{ sessionId: 'w1', directory: '/wt/a', number: 9, repository: 'o/r' }]);
    await watch.apply([{ sessionId: 'w1', repository: 'o/r', number: 9, read: read({ number: 9, checks: green }) }]);
    expect(emit).toHaveBeenLastCalledWith('w1', 'ci_passed', expect.stringContaining('PR #9'));
  });

  it('starts over when the worker reports another pull request', async () => {
    const { watch, emit, document } = setup();
    await watch.apply([{ sessionId: 'w1', repository: 'o/r', number: 7, read: read({ state: 'merged' }) }]);
    document.workers.w1.pullRequest = { number: 9, repository: 'o/r' };
    const registryRead = vi.fn(async () => structuredClone(document));
    const next = createPrWatch({ registry: { read: registryRead }, emit, readSettings: async () => ({}) });
    await next.apply([{ sessionId: 'w1', repository: 'o/r', number: 9, read: read({ number: 9, checks: red }) }]);
    expect(emit).toHaveBeenLastCalledWith('w1', 'ci_failed', expect.stringContaining('PR #9'));
  });
});

describe('a green pull request wakes the orchestrator', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('delivers a ci_passed line through the real wakes', async () => {
    const document = {
      workers: { w1: { orchestratorSessionId: 'orch', title: 'Fix login', state: 'active', cwd: '/wt/a', pullRequest: { number: 7, repository: 'o/r' } } },
      owners: { orch: { cwd: '/repo' } },
    };
    const sent = [];
    let clock = 1_000_000;
    const registry = { read: async () => structuredClone(document) };
    const wakes = createWakes({
      registry,
      getLiveRuntime: () => ({ session: { sendCustomMessage: async (message, options) => { sent.push({ message, options }); } } }),
      activateSession: vi.fn(),
      holdSession: () => () => {},
      stateOf: () => 'idle',
      runStartedAt: () => undefined,
      waitingForInput: () => false,
      readSettings: async () => ({ wakes: { coalesceMs: 3_000 }, watchdog: { enabled: false } }),
      now: () => clock,
      isGone: () => false,
    });
    const watch = createPrWatch({ registry, emit: wakes.emit, readSettings: async () => ({ github: { enabled: true } }) });
    await watch.apply([{ sessionId: 'w1', repository: 'o/r', number: 7, read: read({ checks: green }) }]);
    clock += 3_000;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent).toHaveLength(1);
    expect(sent[0].message.content).toContain('ci_passed');
    expect(sent[0].message.content).toContain('Fix login');
    expect(sent[0].options).toEqual({ triggerTurn: true, deliverAs: 'followUp' });
  });
});
