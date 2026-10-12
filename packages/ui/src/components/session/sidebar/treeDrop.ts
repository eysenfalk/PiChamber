import type { NodeKey } from './workspaceTree';

/** What a tree row carries while it is dragged. `scopeKey` is the session folder scope the row lives in. */
export type TreeDragData =
  | { type: 'session'; sessionId: string; scopeKey: string | null }
  | { type: 'folder'; key: NodeKey; folderId: string; scopeKey: string }
  | { type: 'project'; projectId: string };

/** What a tree row offers as a drop target. Only projects, worktrees and folders are targets. */
export type TreeDropData = {
  key: NodeKey;
  /** Set on a flat project, a worktree and a folder: the folder scope sessions and folders can land in. */
  scopeKey: string | null;
  /** Set on a folder row. */
  folderId: string | null;
  /** Set on a project row, which is also the target of a project reorder. */
  projectId: string | null;
};

export type TreeDropAction =
  | { type: 'addSessionToFolder'; scopeKey: string; folderId: string; sessionId: string }
  | { type: 'removeSessionFromFolder'; scopeKey: string; sessionId: string }
  | { type: 'moveFolder'; scopeKey: string; folderId: string; parentId: string | null }
  | { type: 'reorderProject'; projectId: string; overProjectId: string };

const isInside = (parents: ReadonlyMap<NodeKey, NodeKey>, key: NodeKey, ancestor: NodeKey): boolean => {
  for (let current: NodeKey | undefined = key; current; current = parents.get(current)) {
    if (current === ancestor) return true;
  }
  return false;
};

/**
 * Maps a drag onto a row to one store action, or null when the drop is not
 * allowed. Moving a session or folder to another scope would change its
 * directory, so only drops inside the same scope count. The same function
 * decides whether a row lights up while hovered.
 */
export const resolveTreeDrop = (
  active: TreeDragData,
  over: TreeDropData,
  parents: ReadonlyMap<NodeKey, NodeKey>,
): TreeDropAction | null => {
  if (active.type === 'project') {
    return over.projectId && over.projectId !== active.projectId
      ? { type: 'reorderProject', projectId: active.projectId, overProjectId: over.projectId }
      : null;
  }
  if (!over.scopeKey || over.scopeKey !== active.scopeKey) return null;

  if (active.type === 'session') {
    return over.folderId
      ? { type: 'addSessionToFolder', scopeKey: over.scopeKey, folderId: over.folderId, sessionId: active.sessionId }
      : { type: 'removeSessionFromFolder', scopeKey: over.scopeKey, sessionId: active.sessionId };
  }

  if (over.folderId === active.folderId || isInside(parents, over.key, active.key)) return null;
  return { type: 'moveFolder', scopeKey: over.scopeKey, folderId: active.folderId, parentId: over.folderId };
};
