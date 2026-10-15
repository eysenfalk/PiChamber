import type { PiOrchestrationWorker } from '@/lib/pi/protocol';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Opens a worker's session the way the session sidebar does: leave the full
 * page surfaces, show the chat and select the session with its worktree as
 * the directory hint. A worker that is not resident opens like any other
 * dormant session.
 */
export const openWorkerSession = (worker: Pick<PiOrchestrationWorker, 'sessionId' | 'worktree'>): void => {
  const ui = useUIStore.getState();
  ui.closeMainSurfaces();
  ui.setActiveMainTab('chat');
  useSessionUIStore.getState().setCurrentSession(worker.sessionId, worker.worktree ?? null);
};
