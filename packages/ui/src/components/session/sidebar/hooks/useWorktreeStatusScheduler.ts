import React from 'react';
import type { GitStatus } from '@/lib/api/types';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGitStore, type GitAPI } from '@/stores/useGitStore';
import {
  createWorktreeStatusScheduler,
  type WorktreeStatusEntry,
  type WorktreeStatusScheduler,
} from '../worktreeStatusScheduler';

type WorktreeStatuses = ReadonlyMap<string, WorktreeStatusEntry<GitStatus | null>>;

const NO_STATUSES: WorktreeStatuses = new Map();

/**
 * One light status request for a worktree, cached in `useGitStore`.
 *
 * `useGitStore.fetchStatus` is the cache writer (repository probe, request
 * guards, merge with a newer full status) but it swallows request errors. A
 * request that did not store a result newer than this call is therefore
 * reported as a failure here, so the scheduler can show `?` instead of a stale
 * or empty status. `null` means the directory is not a git repository.
 */
export const fetchLightWorktreeStatus = (path: string, git: GitAPI): Promise<GitStatus | null> =>
  runBackgroundNetworkTask(async () => {
    const startedAt = Date.now();
    await useGitStore.getState().fetchStatus(path, git, { mode: 'light', silent: true });
    const state = useGitStore.getState().directories.get(path);
    if (!state || state.lastStatusFetch < startedAt) {
      throw new Error('Git status request did not complete');
    }
    if (state.isGitRepo === false) return null;
    if (!state.status) throw new Error('Git status request returned no status');
    return state.status;
  });

/**
 * Drives `createWorktreeStatusScheduler` for the worktree paths whose rows are
 * visible. It refreshes on window focus, pauses while the page is hidden, and
 * recreates the scheduler (dropping all recorded state) when the runtime or its
 * git API changes. `refresh` is for expand and the end of a session turn.
 */
export const useWorktreeStatusScheduler = (visiblePaths: readonly string[]) => {
  const { git } = useRuntimeAPIs();
  const runtimeKey = getRuntimeKey();
  const [scheduler, setScheduler] = React.useState<WorktreeStatusScheduler<GitStatus | null> | null>(null);

  React.useEffect(() => {
    const created = createWorktreeStatusScheduler<GitStatus | null>({
      fetchStatus: (path) => fetchLightWorktreeStatus(path, git),
    });
    created.setActive(typeof document === 'undefined' || !document.hidden);

    const onFocus = () => created.refreshVisible();
    const onVisibilityChange = () => created.setActive(!document.hidden);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    setScheduler(created);

    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      created.dispose();
      setScheduler(null);
    };
    // The runtime key is not read inside the effect; it re-creates the scheduler on a runtime switch.
  }, [git, runtimeKey]);

  // A stable key so a new array with the same paths does not reschedule anything.
  const pathsKey = React.useMemo(() => [...new Set(visiblePaths)].sort().join('\0'), [visiblePaths]);
  React.useEffect(() => {
    scheduler?.setVisiblePaths(pathsKey ? pathsKey.split('\0') : []);
  }, [scheduler, pathsKey]);

  const subscribe = React.useCallback(
    (listener: () => void) => scheduler?.subscribe(listener) ?? (() => undefined),
    [scheduler],
  );
  const getSnapshot = React.useCallback(() => scheduler?.getSnapshot() ?? NO_STATUSES, [scheduler]);
  const statuses = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const refresh = React.useCallback((path: string) => scheduler?.refresh(path), [scheduler]);

  return { statuses, refresh };
};
