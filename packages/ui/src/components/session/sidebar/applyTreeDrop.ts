import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import type { TreeDropAction } from './treeDrop';

/** Carries out a drop that `resolveTreeDrop` accepted. Reads the stores at call time, so it holds no state. */
export const applyTreeDrop = (action: TreeDropAction): void => {
  switch (action.type) {
    case 'addSessionToFolder':
      // The store takes the session out of its other folders in the scope.
      useSessionFoldersStore.getState().addSessionToFolder(action.scopeKey, action.folderId, action.sessionId);
      return;
    case 'removeSessionFromFolder':
      useSessionFoldersStore.getState().removeSessionFromFolder(action.scopeKey, action.sessionId);
      return;
    case 'moveFolder':
      useSessionFoldersStore.getState().moveFolder(action.scopeKey, action.folderId, action.parentId);
      return;
    case 'reorderProject': {
      const store = useProjectsStore.getState();
      const from = store.projects.findIndex((project) => project.id === action.projectId);
      const to = store.projects.findIndex((project) => project.id === action.overProjectId);
      if (from >= 0 && to >= 0) store.reorderProjects(from, to);
      return;
    }
  }
};
