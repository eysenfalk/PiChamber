import React from 'react';
import type { Session } from '@/lib/chat/types';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import type { PiSessionStoreState } from '@/apps/pi-session-store';
import { useCatalogUiSessions } from '@/sync/sync-context';
import { isKnownActiveSessionDirectory } from '../sessionOwnership';
import { useAuthoritativeSessionCleanup } from './useAuthoritativeSessionCleanup';

const hasReadyDirectoryList = (state: PiSessionStoreState): boolean => {
  for (const status of state.catalog.listStatusByDirectory.values()) {
    if (status === 'ready') return true;
  }
  return false;
};

/**
 * The sidebar's view of the session catalog: active sessions whose directory
 * the sidebar knows (a registered project, a discovered worktree or home),
 * plus every archived session. Also runs the missed-deletion cleanup.
 */
export const useSidebarSessions = (args: {
  enabled: boolean;
  knownSessionDirectories: Set<string>;
  homeDirectory?: string | null;
}): { sessions: Session[]; archivedSessions: Session[] } => {
  const { enabled, knownSessionDirectories, homeDirectory } = args;
  const catalogReady = usePiSessionSnapshot(hasReadyDirectoryList, undefined, 'catalog');
  const catalogSessions = useCatalogUiSessions({ archived: false });
  const archivedSessions = useCatalogUiSessions({ archived: true });

  const sessions = React.useMemo(() => {
    return catalogSessions.filter((session) => isKnownActiveSessionDirectory(session, knownSessionDirectories, {
      allowUnknownDirectory: true,
      allowEmptyDirectorySet: true,
      homeDirectory,
    }));
  }, [catalogSessions, homeDirectory, knownSessionDirectories]);

  // The cleanup compares complete catalog snapshots, never the filtered view:
  // a directory leaving the known set (a removed worktree, a closed project)
  // hides its sessions but does not delete them, and they return with it.
  const catalogSnapshot = React.useMemo(
    () => [...catalogSessions, ...archivedSessions],
    [archivedSessions, catalogSessions],
  );
  useAuthoritativeSessionCleanup({
    enabled,
    hasAuthoritativeGlobalSessions: catalogReady,
    sessions: catalogSnapshot,
  });

  return { sessions, archivedSessions };
};
