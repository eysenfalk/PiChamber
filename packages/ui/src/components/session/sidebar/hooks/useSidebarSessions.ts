import React from 'react';
import type { Session } from '@/lib/chat/types';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import type { PiSessionStoreState } from '@/apps/pi-session-store';
import { useCatalogUiSessions } from '@/sync/sync-context';
import { isKnownActiveSessionDirectory } from '../sessionOwnership';
import { useAuthoritativeSessionCleanup } from './useAuthoritativeSessionCleanup';

const selectForeignSessionDirectories = (state: PiSessionStoreState): readonly string[] => state.foreignSessionDirectories;

const hasReadyDirectoryList = (state: PiSessionStoreState): boolean => {
  for (const status of state.catalog.listStatusByDirectory.values()) {
    if (status === 'ready') return true;
  }
  return false;
};

/**
 * The sidebar's view of the session catalog: active sessions whose directory
 * the sidebar knows (a registered project, a discovered worktree or home) or
 * that is another existing folder holding sessions (#103, shown under Other
 * folders), plus every archived session. Also runs the missed-deletion cleanup.
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
  const foreignDirectories = usePiSessionSnapshot(selectForeignSessionDirectories, undefined, 'catalog');
  // An empty known set lets every session through; foreign folders must not
  // turn it into a filter.
  const visibleDirectories = React.useMemo(
    () => (knownSessionDirectories.size === 0 || foreignDirectories.length === 0
      ? knownSessionDirectories
      : new Set([...knownSessionDirectories, ...foreignDirectories])),
    [foreignDirectories, knownSessionDirectories],
  );

  const sessions = React.useMemo(() => {
    return catalogSessions.filter((session) => isKnownActiveSessionDirectory(session, visibleDirectories, {
      allowUnknownDirectory: true,
      allowEmptyDirectorySet: true,
      homeDirectory,
    }));
  }, [catalogSessions, homeDirectory, visibleDirectories]);

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
