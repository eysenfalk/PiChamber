import React from 'react';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import type { WorkerFilterMode } from '../workspaceTree';

const STORAGE_KEY = 'oc.sidebar.workerFilter.v1';
const MODES: readonly WorkerFilterMode[] = ['all', 'hide', 'only'];

const readStored = (): WorkerFilterMode => {
  try {
    const raw = getDeferredSafeStorage().getItem(STORAGE_KEY);
    return MODES.find((mode) => mode === raw) ?? 'all';
  } catch {
    return 'all';
  }
};

/** The session list's worker filter. Stored per device only; All by default and for any unknown value. */
export const useWorkerFilter = (): [WorkerFilterMode, (mode: WorkerFilterMode) => void] => {
  const [mode, setMode] = React.useState<WorkerFilterMode>(readStored);
  const update = React.useCallback((next: WorkerFilterMode) => {
    setMode(next);
    try {
      getDeferredSafeStorage().setItem(STORAGE_KEY, next);
    } catch {
      // Storage is best effort; the filter keeps working in memory.
    }
  }, []);
  return [mode, update];
};
