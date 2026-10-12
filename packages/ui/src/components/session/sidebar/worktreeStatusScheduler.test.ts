import { describe, expect, test } from 'bun:test';
import {
  createWorktreeStatusScheduler,
  type WorktreeStatusScheduler,
  type WorktreeStatusTimers,
} from './worktreeStatusScheduler';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
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
  const timers: WorktreeStatusTimers = {
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

type Harness = {
  clock: ReturnType<typeof createClock>;
  scheduler: WorktreeStatusScheduler<string>;
  calls: string[];
  pending: Map<string, Deferred<string>[]>;
  maxInFlight: () => number;
  resolveNext: (path: string, value?: string) => Promise<void>;
  rejectNext: (path: string, error?: unknown) => Promise<void>;
};

const createHarness = (): Harness => {
  const clock = createClock();
  const calls: string[] = [];
  const pending = new Map<string, Deferred<string>[]>();
  let inFlight = 0;
  let peak = 0;
  const scheduler = createWorktreeStatusScheduler<string>({
    now: clock.now,
    timers: clock.timers,
    fetchStatus: (path) => {
      calls.push(path);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const deferred = createDeferred<string>();
      pending.set(path, [...(pending.get(path) ?? []), deferred]);
      return deferred.promise.finally(() => {
        inFlight -= 1;
      });
    },
  });
  const take = (path: string) => {
    const list = pending.get(path) ?? [];
    const deferred = list.shift();
    if (!deferred) throw new Error(`no pending fetch for ${path}`);
    return deferred;
  };
  return {
    clock,
    scheduler,
    calls,
    pending,
    maxInFlight: () => peak,
    resolveNext: async (path, value = `status:${path}`) => {
      take(path).resolve(value);
      await flush();
    },
    rejectNext: async (path, error = new Error('boom')) => {
      take(path).reject(error);
      await flush();
    },
  };
};

describe('worktree status scheduler', () => {
  test('never runs more than two fetches at once and drains the queue as slots free', async () => {
    const h = createHarness();
    h.scheduler.setVisiblePaths(['/a', '/b', '/c', '/d', '/e']);
    expect(h.calls).toEqual(['/a', '/b']);

    await h.resolveNext('/a');
    expect(h.calls).toEqual(['/a', '/b', '/c']);
    await h.resolveNext('/b');
    await h.resolveNext('/c');
    await h.resolveNext('/d');
    await h.resolveNext('/e');

    expect(h.calls).toEqual(['/a', '/b', '/c', '/d', '/e']);
    expect(h.maxInFlight()).toBe(2);
    expect(h.scheduler.getSnapshot().size).toBe(5);
    h.scheduler.dispose();
  });

  test('dedupes a path that is already in flight or queued', async () => {
    const h = createHarness();
    h.scheduler.setVisiblePaths(['/a', '/b', '/c']);
    h.scheduler.setVisiblePaths(['/a', '/b', '/c']);
    h.scheduler.refresh('/c');
    h.scheduler.refresh('/c');
    expect(h.calls).toEqual(['/a', '/b']);

    await h.resolveNext('/a');
    await h.resolveNext('/b');
    await h.resolveNext('/c');
    expect(h.calls).toEqual(['/a', '/b', '/c']);
    h.scheduler.dispose();
  });

  test('a refresh that arrives while the path is in flight runs exactly once more after it settles', async () => {
    const h = createHarness();
    h.scheduler.setVisiblePaths(['/a']);
    h.scheduler.refresh('/a');
    h.scheduler.refresh('/a');
    expect(h.calls).toEqual(['/a']);

    await h.resolveNext('/a', 'first');
    expect(h.calls).toEqual(['/a', '/a']);
    await h.resolveNext('/a', 'second');
    expect(h.calls).toEqual(['/a', '/a']);
    const entry = h.scheduler.getSnapshot().get('/a');
    expect(entry?.kind === 'ready' && entry.status).toBe('second');
    h.scheduler.dispose();
  });

  test('polls each visible path every 60 seconds and not earlier', async () => {
    const h = createHarness();
    h.scheduler.setVisiblePaths(['/a']);
    await h.resolveNext('/a');
    expect(h.calls).toEqual(['/a']);

    await h.clock.advance(59_999);
    expect(h.calls).toEqual(['/a']);
    await h.clock.advance(1);
    expect(h.calls).toEqual(['/a', '/a']);
    await h.resolveNext('/a');

    await h.clock.advance(60_000);
    expect(h.calls).toEqual(['/a', '/a', '/a']);
    h.scheduler.dispose();
  });

  test('budget: 14 visible worktrees cost 14 status requests per minute, two at a time', async () => {
    const h = createHarness();
    const paths = Array.from({ length: 14 }, (_, index) => `/wt/${index}`);
    h.scheduler.setVisiblePaths(paths);
    // Fast status answers: every request settles right after it starts.
    const drain = async () => {
      for (;;) {
        const open = [...h.pending.entries()].find(([, list]) => list.length > 0);
        if (!open) break;
        await h.resolveNext(open[0]);
      }
    };
    await drain();
    expect(h.calls).toHaveLength(14);

    const before = h.calls.length;
    for (let second = 0; second < 60; second += 1) {
      await h.clock.advance(1_000);
      await drain();
    }
    expect(h.calls.length - before).toBe(14);
    expect(new Set(h.calls.slice(before))).toEqual(new Set(paths));
    expect(h.maxInFlight()).toBe(2);
    h.scheduler.dispose();
  });

  test('the cadence counts from the end of the fetch, so slow fetches do not stack', async () => {
    const h = createHarness();
    h.scheduler.setVisiblePaths(['/a']);
    await h.clock.advance(100_000);
    expect(h.calls).toEqual(['/a']);
    await h.resolveNext('/a');
    await h.clock.advance(59_000);
    expect(h.calls).toEqual(['/a']);
    await h.clock.advance(1_000);
    expect(h.calls).toEqual(['/a', '/a']);
    h.scheduler.dispose();
  });

  test('a path that becomes visible again with a fresh entry is not refetched until due', async () => {
    const h = createHarness();
    h.scheduler.setVisiblePaths(['/a']);
    await h.resolveNext('/a');
    h.scheduler.setVisiblePaths([]);
    await h.clock.advance(20_000);
    h.scheduler.setVisiblePaths(['/a']);
    expect(h.calls).toEqual(['/a']);
    await h.clock.advance(40_000);
    expect(h.calls).toEqual(['/a', '/a']);
    h.scheduler.dispose();
  });

  test('a path that leaves the visible set stops polling and loses its queue slot', async () => {
    const h = createHarness();
    h.scheduler.setVisiblePaths(['/a', '/b', '/c']);
    await h.resolveNext('/a');
    await h.resolveNext('/b');
    expect(h.calls).toEqual(['/a', '/b', '/c']);

    h.scheduler.setVisiblePaths(['/a']);
    await h.resolveNext('/c');
    await h.clock.advance(180_000);
    expect(h.calls.filter((path) => path === '/b')).toEqual(['/b']);
    expect(h.calls.filter((path) => path === '/c')).toEqual(['/c']);
    expect(h.calls.filter((path) => path === '/a').length).toBeGreaterThan(1);
    h.scheduler.refresh('/b');
    expect(h.calls.filter((path) => path === '/b')).toEqual(['/b']);
    h.scheduler.dispose();
  });

  test('a queued path that becomes invisible is never fetched', async () => {
    const h = createHarness();
    h.scheduler.setVisiblePaths(['/a', '/b', '/c']);
    h.scheduler.setVisiblePaths(['/a', '/b']);
    await h.resolveNext('/a');
    await h.resolveNext('/b');
    expect(h.calls).toEqual(['/a', '/b']);
    h.scheduler.dispose();
  });

  test('removing every visible path leaves no timer armed', async () => {
    const h = createHarness();
    h.scheduler.setVisiblePaths(['/a']);
    await h.resolveNext('/a');
    expect(h.clock.pendingTimers()).toBe(1);
    h.scheduler.setVisiblePaths([]);
    expect(h.clock.pendingTimers()).toBe(0);
    h.scheduler.dispose();
  });

  test('records a failure, keeps the last known status apart, and retries on the next cadence', async () => {
    const h = createHarness();
    h.scheduler.setVisiblePaths(['/a']);
    await h.resolveNext('/a', 'good');
    const good = h.scheduler.getSnapshot().get('/a');
    expect(good?.kind).toBe('ready');

    await h.clock.advance(60_000);
    await h.rejectNext('/a', new Error('git exploded'));
    const failed = h.scheduler.getSnapshot().get('/a');
    expect(failed?.kind).toBe('failed');
    if (failed?.kind !== 'failed') throw new Error('expected failure');
    expect(failed.error).toBe('git exploded');
    expect(failed.lastKnown?.kind === 'ready' && failed.lastKnown.status).toBe('good');

    await h.clock.advance(59_999);
    expect(h.calls).toHaveLength(2);
    await h.clock.advance(1);
    expect(h.calls).toHaveLength(3);
    await h.resolveNext('/a', 'recovered');
    const recovered = h.scheduler.getSnapshot().get('/a');
    expect(recovered?.kind === 'ready' && recovered.status).toBe('recovered');
    h.scheduler.dispose();
  });

  test('a first failure has no last known status, and a thrown (non Error) value gets a message', async () => {
    const h = createHarness();
    h.scheduler.setVisiblePaths(['/a']);
    await h.rejectNext('/a', 'nope');
    const failed = h.scheduler.getSnapshot().get('/a');
    expect(failed?.kind === 'failed' && failed.lastKnown).toBeNull();
    expect(failed?.kind === 'failed' && failed.error).toBe('Status request failed');
    h.scheduler.dispose();
  });

  test('one failed path does not block or erase another path', async () => {
    const h = createHarness();
    h.scheduler.setVisiblePaths(['/a', '/b']);
    await h.rejectNext('/a');
    await h.resolveNext('/b', 'fine');
    expect(h.scheduler.getSnapshot().get('/a')?.kind).toBe('failed');
    const b = h.scheduler.getSnapshot().get('/b');
    expect(b?.kind === 'ready' && b.status).toBe('fine');
    h.scheduler.dispose();
  });

  test('a synchronous throw from the fetch is recorded as a failure', async () => {
    const clock = createClock();
    const scheduler = createWorktreeStatusScheduler<string>({
      now: clock.now,
      timers: clock.timers,
      fetchStatus: () => {
        throw new Error('sync');
      },
    });
    scheduler.setVisiblePaths(['/a']);
    await flush();
    const entry = scheduler.getSnapshot().get('/a');
    expect(entry?.kind === 'failed' && entry.error).toBe('sync');
    scheduler.dispose();
  });

  test('refresh fetches a visible path on demand and ignores invisible paths', async () => {
    const h = createHarness();
    h.scheduler.setVisiblePaths(['/a']);
    await h.resolveNext('/a');
    h.scheduler.refresh('/a');
    h.scheduler.refresh('/zzz');
    expect(h.calls).toEqual(['/a', '/a']);
    h.scheduler.dispose();
  });

  test('refreshVisible refreshes visible paths older than the focus minimum age only', async () => {
    const h = createHarness();
    h.scheduler.setVisiblePaths(['/a', '/b']);
    await h.resolveNext('/a');
    await h.resolveNext('/b');
    await h.clock.advance(10_000);
    h.scheduler.refresh('/a');
    await h.resolveNext('/a');
    await h.clock.advance(1_000);

    h.scheduler.refreshVisible();
    expect(h.calls).toEqual(['/a', '/b', '/a', '/b']);
    h.scheduler.dispose();
  });

  test('inactive: nothing is fetched or armed; resuming fetches only what is due', async () => {
    const h = createHarness();
    h.scheduler.setVisiblePaths(['/a', '/b']);
    await h.resolveNext('/a');
    await h.resolveNext('/b');

    h.scheduler.setActive(false);
    expect(h.clock.pendingTimers()).toBe(0);
    await h.clock.advance(10_000);
    h.scheduler.refresh('/a');
    expect(h.calls).toHaveLength(2);

    await h.clock.advance(120_000);
    expect(h.calls).toHaveLength(2);

    h.scheduler.setActive(true);
    expect(h.calls).toEqual(['/a', '/b', '/a', '/b']);
    h.scheduler.dispose();
  });

  test('notifies subscribers on every recorded entry with a new snapshot identity', async () => {
    const h = createHarness();
    let notifications = 0;
    const unsubscribe = h.scheduler.subscribe(() => {
      notifications += 1;
    });
    const before = h.scheduler.getSnapshot();
    h.scheduler.setVisiblePaths(['/a']);
    await h.resolveNext('/a');
    expect(notifications).toBe(1);
    expect(h.scheduler.getSnapshot()).not.toBe(before);
    unsubscribe();
    h.scheduler.refresh('/a');
    await h.resolveNext('/a');
    expect(notifications).toBe(1);
    h.scheduler.dispose();
  });

  test('dispose cancels the timer, drops the queue, ignores late results and later calls', async () => {
    const h = createHarness();
    h.scheduler.setVisiblePaths(['/a', '/b', '/c']);
    h.scheduler.dispose();
    expect(h.clock.pendingTimers()).toBe(0);

    await h.resolveNext('/a');
    await h.resolveNext('/b');
    expect(h.calls).toEqual(['/a', '/b']);
    expect(h.scheduler.getSnapshot().size).toBe(0);

    h.scheduler.setVisiblePaths(['/d']);
    h.scheduler.refresh('/d');
    h.scheduler.refreshVisible();
    h.scheduler.setActive(true);
    await h.clock.advance(300_000);
    expect(h.calls).toEqual(['/a', '/b']);
  });
});
