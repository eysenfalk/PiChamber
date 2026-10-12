import React from 'react';
import type { GitWorktree } from '@/lib/api/types';
import type { Session } from '@/lib/chat/types';
import { isSessionPinned } from '@/stores/useSessionPinnedStore';
import type { SessionFoldersMap } from '@/stores/useSessionFoldersStore';
import type { SessionOwnershipIndex } from '../sessionOwnership';
import { formatProjectLabel, normalizePath } from '../utils';
import {
  buildWorkspaceTree,
  type NodeKey,
  type SessionActivity,
  type TreeNode,
  type WorkspaceTree,
} from '../workspaceTree';

type Args = {
  projects: ReadonlyArray<{ id: string; label?: string; normalizedPath: string }>;
  /** Keyed by normalized project path, as `buildAvailableWorktreesByProject` returns it. */
  worktreesByProjectPath: ReadonlyMap<string, readonly GitWorktree[]>;
  ownership: SessionOwnershipIndex;
  sessions: readonly Session[];
  foldersByScope: SessionFoldersMap;
  pinnedSessionIds: Set<string>;
  /** Sessions whose catalog lifecycle is busy or retry. */
  runningSessionIds: ReadonlySet<string>;
  unseenSessionIds: ReadonlySet<string>;
  discoveryComplete: boolean;
  /** Project ids, plus `chats`, the owner hid. */
  hidden: ReadonlySet<string>;
  /** Quick search; empty shows the normal tree. */
  query: string;
};

type WorkspaceTreeModel = {
  tree: WorkspaceTree;
  nodesByKey: ReadonlyMap<NodeKey, TreeNode>;
};

const indexNodes = (roots: readonly TreeNode[]): Map<NodeKey, TreeNode> => {
  const nodes = new Map<NodeKey, TreeNode>();
  const visit = (node: TreeNode) => {
    nodes.set(node.key, node);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return nodes;
};

/** The label a project shows in the tree and in the visibility menu. */
export const treeProjectLabel = (project: { label?: string; normalizedPath: string }): string =>
  formatProjectLabel(project.label?.trim() || project.normalizedPath.split('/').filter(Boolean).pop() || project.normalizedPath);

/**
 * The only reader that feeds `buildWorkspaceTree`. Rows render what this
 * returns and never sort, filter or cut themselves.
 */
export const useWorkspaceTreeModel = ({
  projects,
  worktreesByProjectPath,
  ownership,
  sessions,
  foldersByScope,
  pinnedSessionIds,
  runningSessionIds,
  unseenSessionIds,
  discoveryComplete,
  hidden,
  query,
}: Args): WorkspaceTreeModel => {
  const previousRef = React.useRef<WorkspaceTree | undefined>(undefined);

  const treeProjects = React.useMemo(
    () => projects.map((project) => ({
      id: project.id,
      label: treeProjectLabel(project),
      root: project.normalizedPath,
    })),
    [projects],
  );

  const worktreesByProject = React.useMemo(() => {
    const byId = new Map<string, readonly GitWorktree[]>();
    for (const project of projects) {
      const worktrees = worktreesByProjectPath.get(normalizePath(project.normalizedPath) ?? project.normalizedPath);
      if (worktrees) byId.set(project.id, worktrees);
    }
    return byId;
  }, [projects, worktreesByProjectPath]);

  const activity = React.useMemo(() => {
    const map = new Map<string, SessionActivity>();
    runningSessionIds.forEach((id) => map.set(id, 'running'));
    return map;
  }, [runningSessionIds]);

  return React.useMemo(() => {
    const tree = buildWorkspaceTree({
      projects: treeProjects,
      worktreesByProject,
      ownership,
      sessions,
      foldersByScope,
      isPinned: (session) => isSessionPinned(pinnedSessionIds, session.directory ?? null, session.id),
      activity,
      unseen: unseenSessionIds,
      discoveryComplete,
      previous: previousRef.current,
      hidden,
      query,
    });
    previousRef.current = tree;
    return { tree, nodesByKey: indexNodes(tree.roots) };
  }, [
    activity,
    discoveryComplete,
    foldersByScope,
    hidden,
    ownership,
    query,
    pinnedSessionIds,
    sessions,
    treeProjects,
    unseenSessionIds,
    worktreesByProject,
  ]);
};
