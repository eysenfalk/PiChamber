/**
 * Framework-free scheduler for the light git status of visible worktree rows
 * (slice 5 of #95, decision D4).
 *
 * It owns only *when* a status is fetched and what was last recorded per path.
 * The fetch itself is injected, so the module knows nothing about React, the
 * runtime or `useGitStore`.
 *
 * Contract:
 * - Only visible paths are fetched or polled. `setVisiblePaths` replaces the
 *   set; a path that leaves it is dropped from the queue and its timer is
 *   forgotten. A request already in flight finishes and is recorded.
 * - At most `maxConcurrent` fetches (default 2) run at once, across all paths.
 * - A path is never fetched twice at the same time. `refresh` on a path whose
 *   fetch is already running is remembered and runs once more after it settles,
 *   because the running fetch may have read the repository before the event
 *   that asked for the refresh.
 * - A path is due `intervalMs` (default 60 s) after its last attempt, success
 *   or failure. A failure is therefore retried at the normal cadence, never in
 *   a tight loop.
 * - A failure is recorded as a failure with the last known status kept
 *   separately. It is never turned into an empty or clean status.
 * - While inactive (window hidden) nothing is fetched and no timer is armed.
 *   Becoming active again fetches the paths that are due.
 */

const WORKTREE_STATUS_INTERVAL_MS = 60_000;
const WORKTREE_STATUS_MAX_CONCURRENT = 2;
/** A focus refresh skips paths fetched more recently than this. */
const WORKTREE_STATUS_FOCUS_MIN_AGE_MS = 5_000;

type WorktreeStatusReady<S> = {
  kind: 'ready';
  status: S;
  fetchedAt: number;
};

type WorktreeStatusFailed<S> = {
  kind: 'failed';
  error: string;
  /** When the failed attempt finished. */
  failedAt: number;
  /** The last successful result for this path, if any. Not authoritative any more. */
  lastKnown: WorktreeStatusReady<S> | null;
};

export type WorktreeStatusEntry<S> = WorktreeStatusReady<S> | WorktreeStatusFailed<S>;

export type WorktreeStatusTimers = {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

type WorktreeStatusSchedulerOptions<S> = {
  fetchStatus: (path: string) => Promise<S>;
  now?: () => number;
  timers?: WorktreeStatusTimers;
  maxConcurrent?: number;
  intervalMs?: number;
  focusMinAgeMs?: number;
};

export type WorktreeStatusScheduler<S> = {
  /** Replace the set of visible paths. Newly visible paths without a fresh entry are fetched. */
  setVisiblePaths: (paths: Iterable<string>) => void;
  /** Fetch one visible path now (expand, end of a session turn). Ignored for paths that are not visible. */
  refresh: (path: string) => void;
  /** Refresh every visible path older than the focus minimum age (window focus). */
  refreshVisible: () => void;
  /** Pause (false) or resume (true) all work, e.g. while the window is hidden. */
  setActive: (active: boolean) => void;
  /** Immutable snapshot, replaced whenever any entry changes. */
  getSnapshot: () => ReadonlyMap<string, WorktreeStatusEntry<S>>;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
};

const defaultTimers: WorktreeStatusTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'Status request failed';

export const createWorktreeStatusScheduler = <S>(
  options: WorktreeStatusSchedulerOptions<S>,
): WorktreeStatusScheduler<S> => {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? defaultTimers;
  const maxConcurrent = options.maxConcurrent ?? WORKTREE_STATUS_MAX_CONCURRENT;
  const intervalMs = options.intervalMs ?? WORKTREE_STATUS_INTERVAL_MS;
  const focusMinAgeMs = options.focusMinAgeMs ?? WORKTREE_STATUS_FOCUS_MIN_AGE_MS;

  let visible: ReadonlySet<string> = new Set();
  let snapshot: ReadonlyMap<string, WorktreeStatusEntry<S>> = new Map();
  /** Time of the last finished attempt per path, success or failure. */
  const lastAttemptAt = new Map<string, number>();
  const queue: string[] = [];
  const queued = new Set<string>();
  const inFlight = new Set<string>();
  /** In-flight paths that asked for another fetch after the running one settles. */
  const refetchAfterFlight = new Set<string>();
  const listeners = new Set<() => void>();
  let timerHandle: unknown = null;
  let active = true;
  let disposed = false;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const record = (path: string, entry: WorktreeStatusEntry<S>) => {
    const next = new Map(snapshot);
    next.set(path, entry);
    snapshot = next;
    notify();
  };

  const clearTimer = () => {
    if (timerHandle === null) return;
    timers.clearTimeout(timerHandle);
    timerHandle = null;
  };

  const isDue = (path: string, at: number): boolean => {
    const last = lastAttemptAt.get(path);
    return last === undefined || at - last >= intervalMs;
  };

  const enqueue = (path: string) => {
    if (!visible.has(path)) return;
    if (inFlight.has(path)) {
      refetchAfterFlight.add(path);
      return;
    }
    if (queued.has(path)) return;
    queued.add(path);
    queue.push(path);
  };

  const arm = () => {
    clearTimer();
    if (disposed || !active) return;
    let earliest = Infinity;
    for (const path of visible) {
      if (inFlight.has(path) || queued.has(path)) continue;
      const last = lastAttemptAt.get(path);
      earliest = Math.min(earliest, last === undefined ? now() : last + intervalMs);
    }
    if (earliest === Infinity) return;
    timerHandle = timers.setTimeout(() => {
      timerHandle = null;
      enqueueDue();
      pump();
    }, Math.max(0, earliest - now()));
  };

  const enqueueDue = () => {
    const at = now();
    for (const path of visible) {
      // A running fetch already answers "is it due"; only an explicit refresh re-runs it.
      if (!inFlight.has(path) && isDue(path, at)) enqueue(path);
    }
  };

  const start = (path: string) => {
    inFlight.add(path);
    let request: Promise<S>;
    try {
      request = Promise.resolve(options.fetchStatus(path));
    } catch (error) {
      request = Promise.reject(error);
    }
    void request.then(
      (status) => settle(path, { kind: 'ready', status, fetchedAt: now() }),
      (error: unknown) => settle(path, { kind: 'failed', error: errorMessage(error), failedAt: now(), lastKnown: null }),
    );
  };

  const settle = (path: string, result: WorktreeStatusEntry<S>) => {
    inFlight.delete(path);
    if (disposed) return;
    lastAttemptAt.set(path, now());
    if (result.kind === 'failed') {
      const previous = snapshot.get(path);
      const lastKnown = previous?.kind === 'ready' ? previous : previous?.lastKnown ?? null;
      record(path, { ...result, lastKnown });
    } else {
      record(path, result);
    }
    if (refetchAfterFlight.delete(path)) enqueue(path);
    pump();
  };

  const pump = () => {
    if (disposed) return;
    while (active && inFlight.size < maxConcurrent && queue.length > 0) {
      const path = queue.shift() as string;
      queued.delete(path);
      if (!visible.has(path) || inFlight.has(path)) continue;
      start(path);
    }
    arm();
  };

  return {
    setVisiblePaths: (paths) => {
      if (disposed) return;
      const next = new Set(paths);
      visible = next;
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const path = queue[index] as string;
        if (next.has(path)) continue;
        queue.splice(index, 1);
        queued.delete(path);
      }
      for (const path of refetchAfterFlight) {
        if (!next.has(path)) refetchAfterFlight.delete(path);
      }
      enqueueDue();
      pump();
    },
    refresh: (path) => {
      if (disposed) return;
      enqueue(path);
      pump();
    },
    refreshVisible: () => {
      if (disposed) return;
      const at = now();
      for (const path of visible) {
        const last = lastAttemptAt.get(path);
        if (last === undefined || at - last >= focusMinAgeMs) enqueue(path);
      }
      pump();
    },
    setActive: (nextActive) => {
      if (disposed || active === nextActive) return;
      active = nextActive;
      if (!active) {
        clearTimer();
        return;
      }
      enqueueDue();
      pump();
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      disposed = true;
      clearTimer();
      queue.length = 0;
      queued.clear();
      refetchAfterFlight.clear();
      listeners.clear();
    },
  };
};
