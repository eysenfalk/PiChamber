import React from 'react';
import type { GitWorktree } from '@/lib/api/types';
import type { Session } from '@/lib/chat/types';
import { isSessionPinned } from '@/stores/useSessionPinnedStore';
import { getGitHubPrStatusKey, useGitHubPrStatusStore, type GitHubPrStatusEntry } from '@/stores/useGitHubPrStatusStore';
import type { SessionFoldersMap } from '@/stores/useSessionFoldersStore';
import type { SessionOwnershipIndex } from '../sessionOwnership';
import { formatProjectLabel, normalizePath } from '../utils';
import {
  buildWorkspaceTree,
  type NodeKey,
  type SessionActivity,
  type TreeNode,
  resolveWorkerFilter,
  type WorkerFilterMode,
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
  /** Workers with an open question in the orchestration registry. */
  waitingSessionIds: ReadonlySet<string>;
  workerFilter: WorkerFilterMode;
  /** Worker session ids from the registry; null until it was read, and then the filter shows everything. */
  workerIds: ReadonlySet<string> | null;
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

/**
 * Linked worktrees whose pull request is merged, as a newline joined, sorted
 * path list so the tree only rebuilds when the set itself changes.
 */
const mergedWorktreePaths = (
  worktreesByProject: ReadonlyMap<string, readonly GitWorktree[]>,
  results: Record<string, GitHubPrStatusEntry>,
): string => {
  const paths: string[] = [];
  for (const worktrees of worktreesByProject.values()) {
    for (const worktree of worktrees) {
      if (worktree.isPrimary || !worktree.branch) continue;
      const key = getGitHubPrStatusKey(worktree.path, worktree.branch);
      if (key && results[key]?.pr?.state === 'merged') {
        const path = normalizePath(worktree.path);
        if (path) paths.push(path);
      }
    }
  }
  return paths.sort().join('\n');
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
  waitingSessionIds,
  workerFilter,
  workerIds,
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

  const prResults = useGitHubPrStatusStore((state) => state.results);
  const mergedKey = React.useMemo(() => mergedWorktreePaths(worktreesByProject, prResults), [prResults, worktreesByProject]);
  const mergedWorktrees = React.useMemo(() => new Set(mergedKey ? mergedKey.split('\n') : []), [mergedKey]);

  const activity = React.useMemo(() => {
    const map = new Map<string, SessionActivity>();
    waitingSessionIds.forEach((id) => map.set(id, 'waiting'));
    // A running session is not waiting for an answer, whatever the registry still says.
    runningSessionIds.forEach((id) => map.set(id, 'running'));
    return map;
  }, [runningSessionIds, waitingSessionIds]);

  const treeWorkerFilter = React.useMemo(() => resolveWorkerFilter(workerFilter, workerIds), [workerFilter, workerIds]);

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
      mergedWorktrees,
      workerFilter: treeWorkerFilter,
    });
    previousRef.current = tree;
    return { tree, nodesByKey: indexNodes(tree.roots) };
  }, [
    activity,
    discoveryComplete,
    foldersByScope,
    hidden,
    mergedWorktrees,
    ownership,
    query,
    pinnedSessionIds,
    sessions,
    treeProjects,
    treeWorkerFilter,
    unseenSessionIds,
    worktreesByProject,
  ]);
};
