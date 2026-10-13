import { describe, expect, test } from 'bun:test';
import {
  createAutoFetchScheduler,
  type AutoFetchRepository,
  type AutoFetchScheduler,
  type AutoFetchTimers,
} from './autoFetchScheduler';

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

const createDeferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

/** Manual clock: timers fire only when time is advanced. */
const createClock = () => {
  let time = 1_000;
  let nextId = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: AutoFetchTimers = {
    setTimeout: (callback, delayMs) => {
      const id = nextId++;
      pending.set(id, { at: time + delayMs, callback });
      return id;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number);
    },
  };
  const advance = async (ms: number) => {
    const target = time + ms;
    for (;;) {
      const due = [...pending.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      time = Math.max(time, due[1].at);
      due[1].callback();
      await flush();
    }
    time = target;
  };
  return { now: () => time, timers, advance, pendingTimers: () => pending.size };
};

const MINUTE = 60_000;

type Harness = {
  scheduler: AutoFetchScheduler;
  clock: ReturnType<typeof createClock>;
  /** Roots in the order their fetch started. */
  calls: string[];
  fetched: Array<{ root: string; paths: readonly string[] }>;
  pending: Map<string, Deferred[]>;
  /** Resolve (or reject) the oldest open request of a root. */
  settle: (root: string, error?: Error) => Promise<void>;
  /** Fetches that finish immediately, unless a root is in `failing`. */
  failing: Set<string>;
};

const repo = (root: string, ...worktreePaths: string[]): AutoFetchRepository => ({
  root,
  worktreePaths: worktreePaths.length > 0 ? worktreePaths : [root],
});

/** `manual` leaves every fetch open until `settle`; otherwise fetches finish at once. */
const createHarness = (manual = false): Harness => {
  const clock = createClock();
  const calls: string[] = [];
  const fetched: Harness['fetched'] = [];
  const pending = new Map<string, Deferred[]>();
  const failing = new Set<string>();
  const scheduler = createAutoFetchScheduler({
    now: clock.now,
    timers: clock.timers,
    fetchRepository: (root) => {
      calls.push(root);
      if (!manual) return failing.has(root) ? Promise.reject(new Error('credentials required')) : Promise.resolve();
      const deferred = createDeferred();
      pending.set(root, [...(pending.get(root) ?? []), deferred]);
      return deferred.promise;
    },
    onFetched: (root, paths) => {
      fetched.push({ root, paths });
    },
  });
  return {
    scheduler,
    clock,
    calls,
    fetched,
    pending,
    failing,
    settle: async (root, error) => {
      const deferred = pending.get(root)?.shift();
      if (!deferred) throw new Error(`no open fetch for ${root}`);
      if (error) deferred.reject(error);
      else deferred.resolve();
      await flush();
    },
  };
};

const enable = (scheduler: AutoFetchScheduler, minutes = 15) =>
  scheduler.configure({ enabled: true, intervalMs: minutes * MINUTE });

describe('createAutoFetchScheduler', () => {
  test('does nothing while disabled', async () => {
    const { scheduler, clock, calls } = createHarness();
    scheduler.setRepositories([repo('/a')]);
    await clock.advance(120 * MINUTE);
    expect(calls).toEqual([]);
    expect(clock.pendingTimers()).toBe(0);
  });

  test('fetches once per repository, not per worktree, and refreshes every visible worktree path', async () => {
    const { scheduler, calls, fetched } = createHarness();
    enable(scheduler);
    scheduler.setRepositories([repo('/a', '/a', '/a-wt1', '/a-wt2'), repo('/b')]);
    await flush();
    expect(calls).toEqual(['/a', '/b']);
    expect(fetched).toEqual([
      { root: '/a', paths: ['/a', '/a-wt1', '/a-wt2'] },
      { root: '/b', paths: ['/b'] },
    ]);
  });

  test('fetches one repository at a time', async () => {
    const harness = createHarness(true);
    enable(harness.scheduler);
    harness.scheduler.setRepositories([repo('/a'), repo('/b'), repo('/c')]);
    await flush();
    expect(harness.calls).toEqual(['/a']);
    await harness.settle('/a');
    expect(harness.calls).toEqual(['/a', '/b']);
    await harness.settle('/b');
    await harness.settle('/c').catch(() => undefined);
    expect(harness.calls).toEqual(['/a', '/b', '/c']);
  });

  test('runs a round immediately when enabled, then every interval', async () => {
    const { scheduler, clock, calls } = createHarness();
    scheduler.setRepositories([repo('/a')]);
    enable(scheduler, 5);
    await flush();
    expect(calls).toEqual(['/a']);
    await clock.advance(5 * MINUTE - 1);
    expect(calls).toEqual(['/a']);
    await clock.advance(1);
    expect(calls).toEqual(['/a', '/a']);
    await clock.advance(5 * MINUTE);
    expect(calls).toEqual(['/a', '/a', '/a']);
  });

  test('records the last fetch time per repository', async () => {
    const { scheduler, clock, settle } = createHarness(true);
    enable(scheduler);
    scheduler.setRepositories([repo('/a')]);
    await flush();
    await clock.advance(2_000);
    await settle('/a');
    expect(scheduler.getSnapshot().get('/a')).toEqual({
      lastFetchedAt: 3_000,
      lastError: null,
      lastAttemptAt: 3_000,
    });
  });

  test('a failure is recorded, keeps the last good fetch time, blocks nothing and the next round still runs', async () => {
    const { scheduler, clock, calls, failing, fetched } = createHarness();
    enable(scheduler, 5);
    scheduler.setRepositories([repo('/a'), repo('/b')]);
    await flush();
    const firstFetchAt = scheduler.getSnapshot().get('/a')?.lastFetchedAt;
    expect(firstFetchAt).toBe(1_000);

    failing.add('/a');
    await clock.advance(5 * MINUTE);
    expect(calls).toEqual(['/a', '/b', '/a', '/b']);
    expect(scheduler.getSnapshot().get('/a')).toEqual({
      lastFetchedAt: firstFetchAt as number,
      lastError: 'credentials required',
      lastAttemptAt: 1_000 + 5 * MINUTE,
    });
    // The other repository was not affected and was still refreshed.
    expect(scheduler.getSnapshot().get('/b')?.lastError).toBeNull();
    expect(fetched.filter((entry) => entry.root === '/a')).toHaveLength(1);

    failing.delete('/a');
    await clock.advance(5 * MINUTE);
    expect(calls.filter((root) => root === '/a')).toHaveLength(3);
    expect(scheduler.getSnapshot().get('/a')?.lastError).toBeNull();
    expect(fetched.filter((entry) => entry.root === '/a')).toHaveLength(2);
  });

  test('a failed repository is retried at the normal cadence, not in a loop', async () => {
    const { scheduler, clock, calls, failing } = createHarness();
    failing.add('/a');
    enable(scheduler, 15);
    scheduler.setRepositories([repo('/a')]);
    await flush();
    await clock.advance(14 * MINUTE);
    expect(calls).toEqual(['/a']);
    await clock.advance(MINUTE);
    expect(calls).toEqual(['/a', '/a']);
  });

  test('a fetch that throws synchronously is recorded as a failure', async () => {
    const clock = createClock();
    const scheduler = createAutoFetchScheduler({
      now: clock.now,
      timers: clock.timers,
      fetchRepository: () => {
        throw new Error('boom');
      },
    });
    enable(scheduler);
    scheduler.setRepositories([repo('/a')]);
    await flush();
    expect(scheduler.getSnapshot().get('/a')?.lastError).toBe('boom');
  });

  test('a failing status refresh callback does not stop the next round', async () => {
    const clock = createClock();
    const calls: string[] = [];
    const scheduler = createAutoFetchScheduler({
      now: clock.now,
      timers: clock.timers,
      fetchRepository: async (root) => {
        calls.push(root);
      },
      onFetched: () => {
        throw new Error('refresh failed');
      },
    });
    enable(scheduler, 5);
    scheduler.setRepositories([repo('/a')]);
    await flush();
    await clock.advance(5 * MINUTE);
    expect(calls).toEqual(['/a', '/a']);
  });

  test('pauses while inactive and catches up when active again if overdue', async () => {
    const { scheduler, clock, calls } = createHarness();
    enable(scheduler, 15);
    scheduler.setRepositories([repo('/a')]);
    await flush();
    expect(calls).toEqual(['/a']);

    scheduler.setActive(false);
    expect(clock.pendingTimers()).toBe(0);
    await clock.advance(60 * MINUTE);
    expect(calls).toEqual(['/a']);

    scheduler.setActive(true);
    await flush();
    expect(calls).toEqual(['/a', '/a']);
  });

  test('becoming active again before the repository is overdue does not fetch', async () => {
    const { scheduler, clock, calls } = createHarness();
    enable(scheduler, 15);
    scheduler.setRepositories([repo('/a')]);
    await flush();
    scheduler.setActive(false);
    await clock.advance(5 * MINUTE);
    scheduler.setActive(true);
    await flush();
    expect(calls).toEqual(['/a']);
    await clock.advance(10 * MINUTE);
    expect(calls).toEqual(['/a', '/a']);
  });

  test('a fetch running while paused finishes, is recorded, and nothing new starts', async () => {
    const harness = createHarness(true);
    enable(harness.scheduler);
    harness.scheduler.setRepositories([repo('/a'), repo('/b')]);
    await flush();
    harness.scheduler.setActive(false);
    await harness.settle('/a');
    expect(harness.scheduler.getSnapshot().get('/a')?.lastError).toBeNull();
    expect(harness.calls).toEqual(['/a']);
    expect(harness.clock.pendingTimers()).toBe(0);
  });

  test('disabling cancels the timer and queued work, and re-enabling does not refetch before it is due', async () => {
    const { scheduler, clock, calls } = createHarness();
    enable(scheduler, 15);
    scheduler.setRepositories([repo('/a')]);
    await flush();
    expect(clock.pendingTimers()).toBe(1);

    scheduler.configure({ enabled: false, intervalMs: 15 * MINUTE });
    expect(clock.pendingTimers()).toBe(0);
    await clock.advance(10 * MINUTE);
    expect(calls).toEqual(['/a']);

    enable(scheduler, 15);
    await flush();
    expect(calls).toEqual(['/a']);
    await clock.advance(5 * MINUTE);
    expect(calls).toEqual(['/a', '/a']);
  });

  test('disabling drops repositories still queued behind a running fetch', async () => {
    const harness = createHarness(true);
    enable(harness.scheduler);
    harness.scheduler.setRepositories([repo('/a'), repo('/b')]);
    await flush();
    harness.scheduler.configure({ enabled: false, intervalMs: 15 * MINUTE });
    await harness.settle('/a');
    expect(harness.calls).toEqual(['/a']);
  });

  test('changing the interval re-times the next fetch from the last attempt', async () => {
    const { scheduler, clock, calls } = createHarness();
    enable(scheduler, 60);
    scheduler.setRepositories([repo('/a')]);
    await flush();
    await clock.advance(10 * MINUTE);
    enable(scheduler, 5);
    await flush();
    // 10 minutes since the last attempt is already past the new 5 minute interval.
    expect(calls).toEqual(['/a', '/a']);
    await clock.advance(5 * MINUTE);
    expect(calls).toEqual(['/a', '/a', '/a']);
  });

  test('a longer interval pushes a not yet started fetch back', async () => {
    const { scheduler, clock, calls } = createHarness();
    enable(scheduler, 5);
    scheduler.setRepositories([repo('/a')]);
    await flush();
    await clock.advance(4 * MINUTE);
    enable(scheduler, 60);
    await clock.advance(30 * MINUTE);
    expect(calls).toEqual(['/a']);
    await clock.advance(26 * MINUTE);
    expect(calls).toEqual(['/a', '/a']);
  });

  test('a visible set change fetches only repositories that are new and due, never early', async () => {
    const { scheduler, clock, calls } = createHarness();
    enable(scheduler, 15);
    scheduler.setRepositories([repo('/a')]);
    await flush();
    await clock.advance(5 * MINUTE);

    scheduler.setRepositories([repo('/a'), repo('/b')]);
    await flush();
    expect(calls).toEqual(['/a', '/b']);

    // /a leaves and returns before it is due again: no refetch.
    scheduler.setRepositories([repo('/b')]);
    await flush();
    scheduler.setRepositories([repo('/a'), repo('/b')]);
    await flush();
    expect(calls).toEqual(['/a', '/b']);

    // Reordering and changing worktree paths of a known repository is not a reason to fetch.
    scheduler.setRepositories([repo('/b'), repo('/a', '/a', '/a-new')]);
    await flush();
    expect(calls).toEqual(['/a', '/b']);

    // A returning repository that became overdue while hidden from the tree is fetched when it shows.
    scheduler.setRepositories([repo('/b')]);
    await clock.advance(11 * MINUTE);
    scheduler.setRepositories([repo('/a'), repo('/b')]);
    await flush();
    expect(calls.filter((root) => root === '/a')).toHaveLength(2);
  });

  test('a repository that leaves the visible set while queued is not fetched', async () => {
    const harness = createHarness(true);
    enable(harness.scheduler);
    harness.scheduler.setRepositories([repo('/a'), repo('/b')]);
    await flush();
    harness.scheduler.setRepositories([repo('/a')]);
    await harness.settle('/a');
    expect(harness.calls).toEqual(['/a']);
  });

  test('a repository that is no longer visible when its fetch finishes is recorded but not refreshed', async () => {
    const harness = createHarness(true);
    enable(harness.scheduler);
    harness.scheduler.setRepositories([repo('/a')]);
    await flush();
    harness.scheduler.setRepositories([]);
    await harness.settle('/a');
    expect(harness.scheduler.getSnapshot().get('/a')?.lastFetchedAt).not.toBeNull();
    expect(harness.fetched).toEqual([]);
  });

  test('duplicate roots are fetched once and their worktree paths merged', async () => {
    const { scheduler, calls, fetched } = createHarness();
    enable(scheduler);
    scheduler.setRepositories([repo('/a', '/a'), repo('/a', '/a-wt')]);
    await flush();
    expect(calls).toEqual(['/a']);
    expect(fetched[0]?.paths).toEqual(['/a', '/a-wt']);
  });

  test('dispose cancels the timer, ignores a running fetch and notifies nobody', async () => {
    const harness = createHarness(true);
    enable(harness.scheduler);
    harness.scheduler.setRepositories([repo('/a')]);
    await flush();
    let notified = 0;
    harness.scheduler.subscribe(() => {
      notified += 1;
    });
    harness.scheduler.dispose();
    expect(harness.clock.pendingTimers()).toBe(0);
    await harness.settle('/a');
    expect(notified).toBe(0);
    expect(harness.fetched).toEqual([]);
    expect(harness.scheduler.getSnapshot().size).toBe(0);

    harness.scheduler.setRepositories([repo('/b')]);
    enable(harness.scheduler);
    await harness.clock.advance(60 * MINUTE);
    expect(harness.calls).toEqual(['/a']);
  });

  test('subscribers are notified with a new snapshot when a repository settles', async () => {
    const { scheduler } = createHarness();
    const seen: unknown[] = [];
    const unsubscribe = scheduler.subscribe(() => seen.push(scheduler.getSnapshot()));
    const before = scheduler.getSnapshot();
    enable(scheduler);
    scheduler.setRepositories([repo('/a')]);
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(before);
    unsubscribe();
  });
});
