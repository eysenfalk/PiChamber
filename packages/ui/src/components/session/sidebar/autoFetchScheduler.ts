/**
 * Framework-free timer for Auto fetch (slice 6 of #95).
 *
 * It owns only *when* a repository is fetched and what was recorded per
 * repository. The fetch itself and the follow-up status refresh are injected,
 * so the module knows nothing about React, the runtime or git.
 *
 * Contract:
 * - Nothing runs and no timer is armed while disabled, inactive (window
 *   hidden) or disposed.
 * - The unit is a repository (its project root), never a worktree. Only the
 *   repositories given to `setRepositories` (the visible projects) are fetched.
 * - One fetch at a time across all repositories.
 * - A repository is due when it has never been attempted or its last attempt
 *   (success or failure) is at least `intervalMs` old. Enabling, becoming
 *   active again and a repository becoming visible fetch what is due, so a
 *   changed visible set, a toggle or a re-show never refetches early. A failure
 *   is retried at the normal cadence, never in a tight loop.
 * - After a successful fetch `onFetched` receives the repository's visible
 *   worktree paths, so the caller can refresh their light status.
 * - A failure is recorded per repository with the last successful fetch time
 *   kept; it blocks no other repository and no later round.
 * - A fetch already running when the scheduler is disabled, paused or changed
 *   finishes and is recorded; nothing new starts. After `dispose` it is ignored.
 */

const DEFAULT_INTERVAL_MS = 15 * 60_000;

export type AutoFetchRepository = {
  /** The repository's project root path; the fetch runs here. */
  root: string;
  /** Visible worktree paths of the repository. */
  worktreePaths: readonly string[];
};

export type AutoFetchRepositoryState = {
  /** When the last successful fetch finished, or null when none has. */
  lastFetchedAt: number | null;
  /** Message of the last attempt when it failed; cleared by the next success. */
  lastError: string | null;
  /** When the last attempt finished, success or failure. */
  lastAttemptAt: number;
};

export type AutoFetchTimers = {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

type AutoFetchSchedulerOptions = {
  fetchRepository: (root: string) => Promise<unknown>;
  onFetched?: (root: string, worktreePaths: readonly string[]) => void;
  now?: () => number;
  timers?: AutoFetchTimers;
};

export type AutoFetchScheduler = {
  /** Turn the timer on or off and set the interval. Changing either never fetches a repository that is not due. */
  configure: (config: { enabled: boolean; intervalMs: number }) => void;
  /** Replace the visible repositories. Newly visible ones that are due are fetched. */
  setRepositories: (repositories: Iterable<AutoFetchRepository>) => void;
  /** Pause (false) or resume (true), e.g. while the window is hidden. */
  setActive: (active: boolean) => void;
  /** Immutable snapshot, replaced whenever a repository's state changes. */
  getSnapshot: () => ReadonlyMap<string, AutoFetchRepositoryState>;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
};

const defaultTimers: AutoFetchTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'Fetch failed';

export const createAutoFetchScheduler = (options: AutoFetchSchedulerOptions): AutoFetchScheduler => {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? defaultTimers;

  let enabled = false;
  let active = true;
  let disposed = false;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let repositories: ReadonlyMap<string, readonly string[]> = new Map();
  let snapshot: ReadonlyMap<string, AutoFetchRepositoryState> = new Map();
  const queue: string[] = [];
  const queued = new Set<string>();
  let inFlight: string | null = null;
  const listeners = new Set<() => void>();
  let timerHandle: unknown = null;

  const canRun = () => enabled && active && !disposed;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const clearTimer = () => {
    if (timerHandle === null) return;
    timers.clearTimeout(timerHandle);
    timerHandle = null;
  };

  const clearQueue = () => {
    queue.length = 0;
    queued.clear();
  };

  const dueAt = (root: string): number => {
    const last = snapshot.get(root)?.lastAttemptAt;
    return last === undefined ? Number.NEGATIVE_INFINITY : last + intervalMs;
  };

  const enqueueDue = () => {
    const at = now();
    for (const root of repositories.keys()) {
      if (root === inFlight || queued.has(root) || dueAt(root) > at) continue;
      queued.add(root);
      queue.push(root);
    }
  };

  const arm = () => {
    clearTimer();
    if (!canRun() || inFlight !== null || queue.length > 0) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const root of repositories.keys()) earliest = Math.min(earliest, dueAt(root));
    if (earliest === Number.POSITIVE_INFINITY) return;
    timerHandle = timers.setTimeout(() => {
      timerHandle = null;
      enqueueDue();
      pump();
    }, Math.max(0, earliest - now()));
  };

  const pump = () => {
    if (canRun() && inFlight === null) {
      while (queue.length > 0) {
        const root = queue.shift() as string;
        queued.delete(root);
        // The visible set or the interval may have changed since it was queued.
        if (!repositories.has(root) || dueAt(root) > now()) continue;
        start(root);
        break;
      }
    }
    arm();
  };

  const start = (root: string) => {
    inFlight = root;
    let request: Promise<unknown>;
    try {
      request = Promise.resolve(options.fetchRepository(root));
    } catch (error) {
      request = Promise.reject(error);
    }
    void request.then(
      () => settle(root, null),
      (error: unknown) => settle(root, errorMessage(error)),
    );
  };

  const settle = (root: string, error: string | null) => {
    inFlight = null;
    if (disposed) return;
    const at = now();
    const previous = snapshot.get(root);
    const next = new Map(snapshot);
    next.set(root, {
      lastFetchedAt: error === null ? at : previous?.lastFetchedAt ?? null,
      lastError: error,
      lastAttemptAt: at,
    });
    snapshot = next;
    notify();
    const worktreePaths = repositories.get(root);
    if (error === null && worktreePaths) {
      try {
        options.onFetched?.(root, worktreePaths);
      } catch {
        // A failing status refresh must not stop the next round.
      }
    }
    pump();
  };

  const reconsider = () => {
    if (!canRun()) {
      clearTimer();
      clearQueue();
      return;
    }
    enqueueDue();
    pump();
  };

  return {
    configure: (config) => {
      if (disposed) return;
      enabled = config.enabled;
      intervalMs = config.intervalMs;
      reconsider();
    },
    setRepositories: (next) => {
      if (disposed) return;
      const map = new Map<string, string[]>();
      for (const repository of next) {
        const paths = map.get(repository.root);
        if (paths) paths.push(...repository.worktreePaths);
        else map.set(repository.root, [...repository.worktreePaths]);
      }
      repositories = map;
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const root = queue[index] as string;
        if (map.has(root)) continue;
        queue.splice(index, 1);
        queued.delete(root);
      }
      reconsider();
    },
    setActive: (nextActive) => {
      if (disposed || active === nextActive) return;
      active = nextActive;
      reconsider();
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
      clearQueue();
      listeners.clear();
    },
  };
};
