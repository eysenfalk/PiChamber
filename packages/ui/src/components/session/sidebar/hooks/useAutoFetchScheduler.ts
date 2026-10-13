import React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { normalizeAutoFetchIntervalMinutes } from '@/lib/autoFetchSettings';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';
import {
  createAutoFetchScheduler,
  type AutoFetchRepository,
  type AutoFetchRepositoryState,
  type AutoFetchScheduler,
} from '../autoFetchScheduler';

type AutoFetchStates = ReadonlyMap<string, AutoFetchRepositoryState>;

const NO_STATES: AutoFetchStates = new Map();

const MINUTE_MS = 60_000;

/**
 * Drives `createAutoFetchScheduler` for the repositories of the visible
 * projects (slice 6 of #95). `onFetched` is called with a repository's visible
 * worktree paths after a successful fetch; pass the status scheduler's
 * `refresh`. The scheduler pauses while the page is hidden and is recreated
 * (dropping all recorded state) when the runtime or its git API changes. While
 * the setting is off the returned map is empty.
 */
export const useAutoFetchScheduler = (
  repositories: readonly AutoFetchRepository[],
  onFetched: (path: string) => void,
): AutoFetchStates => {
  const { git } = useRuntimeAPIs();
  const runtimeKey = getRuntimeKey();
  const enabled = useUIStore((state) => state.gitAutoFetchEnabled);
  const intervalMinutes = useUIStore((state) => state.gitAutoFetchIntervalMinutes);
  const [scheduler, setScheduler] = React.useState<AutoFetchScheduler | null>(null);

  const onFetchedRef = React.useRef(onFetched);
  React.useEffect(() => {
    onFetchedRef.current = onFetched;
  }, [onFetched]);

  React.useEffect(() => {
    const created = createAutoFetchScheduler({
      fetchRepository: async (root) => {
        const result = await git.gitFetch(root);
        if (result && result.success === false) throw new Error('Fetch failed');
      },
      onFetched: (_root, worktreePaths) => {
        for (const path of worktreePaths) onFetchedRef.current(path);
      },
    });
    created.setActive(typeof document === 'undefined' || !document.hidden);

    const onVisibilityChange = () => created.setActive(!document.hidden);
    document.addEventListener('visibilitychange', onVisibilityChange);
    setScheduler(created);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      created.dispose();
      setScheduler(null);
    };
    // The runtime key is not read inside the effect; it re-creates the scheduler on a runtime switch.
  }, [git, runtimeKey]);

  React.useEffect(() => {
    scheduler?.configure({ enabled, intervalMs: normalizeAutoFetchIntervalMinutes(intervalMinutes) * MINUTE_MS });
  }, [scheduler, enabled, intervalMinutes]);

  // A stable key so a new array with the same repositories does not reschedule anything.
  const repositoriesKey = React.useMemo(() => JSON.stringify(
    repositories
      .map((repository) => [repository.root, [...new Set(repository.worktreePaths)].sort()] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ), [repositories]);
  React.useEffect(() => {
    const parsed = JSON.parse(repositoriesKey) as Array<[string, string[]]>;
    scheduler?.setRepositories(parsed.map(([root, worktreePaths]) => ({ root, worktreePaths })));
  }, [scheduler, repositoriesKey]);

  const subscribe = React.useCallback(
    (listener: () => void) => scheduler?.subscribe(listener) ?? (() => undefined),
    [scheduler],
  );
  const getSnapshot = React.useCallback(() => scheduler?.getSnapshot() ?? NO_STATES, [scheduler]);
  const states = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return enabled ? states : NO_STATES;
};
