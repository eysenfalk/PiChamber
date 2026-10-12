import type { GitWorktree } from '@/lib/api/types';
import type { Session } from '@/lib/chat/types';
import { normalizePath } from '@/lib/pathNormalization';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';
import type { SessionOwnershipIndex } from './sessionOwnership';

/**
 * Pure model of the sidebar workspace tree (spec 95, slice 1).
 *
 * Chats, then projects in their manual order, then Other folders. A project
 * expands to its worktrees (or directly to its sessions when it has only the
 * primary checkout), a worktree to its sessions and session folders, a session
 * to its forks. Every active session lands in exactly one node. Renderers must
 * not sort, filter or cut; everything order related lives here.
 */

const SESSIONS_BEFORE_MORE = 5;

export type NodeKey =
  | 'chats'
  | 'other'
  | `p:${string}`
  | `w:${string}`
  | `f:${string}`
  | `s:${string}`
  | `more:${string}`
  | `merged:${string}`
  | `o:${string}`;

export type TreeNodeKind =
  | 'chats'
  | 'project'
  | 'worktree'
  | 'folder'
  | 'session'
  | 'more'
  | 'merged'
  | 'other'
  | 'otherFolder';

export type TreeRollup = { running: boolean; waiting: boolean; unseen: boolean };

export type TreeNode = {
  key: NodeKey;
  kind: TreeNodeKind;
  /** Data-derived label (project, branch, folder, session title, directory). Empty for fixed nodes, which the renderer names. */
  label: string;
  children: TreeNode[];
  /** Sessions in this subtree. For a session node: the forks below it. */
  sessionCount: number;
  /** Direct forks of a session node; 0 for other kinds. */
  forkCount: number;
  lastActivity: number;
  rollup: TreeRollup;
  session?: Session;
  pinned?: boolean;
  worktree?: GitWorktree;
  projectId?: string;
  /** Directory a new session in this node would use: the worktree, flat project root, or `~` for Chats. */
  directory?: string;
  /** Session folder scope of this container (worktree or flat project). */
  folderScopeKey?: string;
};

export type WorkspaceTreeProject = { id: string; label: string; root: string };

export type SessionActivity = 'running' | 'waiting';

export type WorkspaceTreeInput = {
  /** Registered projects in their manual order. */
  projects: readonly WorkspaceTreeProject[];
  /** Discovered worktrees per project id, the primary checkout included or not. */
  worktreesByProject: ReadonlyMap<string, readonly GitWorktree[]>;
  ownership: Pick<SessionOwnershipIndex, 'bySessionId' | 'globalSessions' | 'unownedSessions'>;
  /** Active sessions of the catalog. Archived sessions are ignored. */
  sessions: readonly Session[];
  foldersByScope: Readonly<Record<string, readonly SessionFolder[]>>;
  isPinned: (session: Session) => boolean;
  /** Live status: only the live status index may feed this, never history. */
  activity: ReadonlyMap<string, SessionActivity>;
  unseen: ReadonlySet<string>;
  /** Worktree paths whose pull request is merged (fed from slice 5 on). */
  mergedWorktrees?: ReadonlySet<string>;
  /** False while worktree discovery is still running for any project. */
  discoveryComplete: boolean;
  /** The previous tree; keeps ownerless sessions in place while discovery is incomplete. */
  previous?: Pick<WorkspaceTree, 'placement' | 'parents'>;
};

export type WorkspaceTree = {
  roots: TreeNode[];
  sessionCount: number;
  /** Parent of every non-root node. */
  parents: ReadonlyMap<NodeKey, NodeKey>;
  /** Container node (worktree, flat project, Chats, other folder) of every session. */
  placement: ReadonlyMap<string, NodeKey>;
};

export type TreeRow = {
  key: NodeKey;
  depth: number;
  node: TreeNode;
  expanded: boolean;
  /** Per ancestor level: whether a guide line continues past this row. */
  guides: boolean[];
  isLast: boolean;
};

const EMPTY_ROLLUP: TreeRollup = { running: false, waiting: false, unseen: false };

const sessionDirectory = (session: Session): string | null => {
  const record = session as Session & { project?: { worktree?: string | null } | null };
  return normalizePath(session.directory) ?? normalizePath(record.project?.worktree);
};

const sessionActivityTime = (session: Session): number => session.time?.updated ?? session.time?.created ?? 0;

const baseName = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index >= 0 ? trimmed.slice(index + 1) || trimmed : trimmed;
};

const mergeRollup = (target: TreeRollup, source: TreeRollup): void => {
  target.running ||= source.running;
  target.waiting ||= source.waiting;
  target.unseen ||= source.unseen;
};

const summarize = (node: TreeNode): TreeNode => {
  const rollup = { ...EMPTY_ROLLUP };
  let sessionCount = 0;
  let lastActivity = 0;
  for (const child of node.children) {
    mergeRollup(rollup, child.rollup);
    sessionCount += child.kind === 'session' ? 1 + child.sessionCount : child.sessionCount;
    lastActivity = Math.max(lastActivity, child.lastActivity);
  }
  node.rollup = rollup;
  node.sessionCount = sessionCount;
  node.lastActivity = lastActivity;
  return node;
};

const activityRank = (node: TreeNode): number => {
  if (node.rollup.running) return 0;
  if (node.rollup.waiting) return 1;
  if (node.pinned) return 2;
  return 3;
};

const compareSessionNodes = (a: TreeNode, b: TreeNode): number => {
  const rank = activityRank(a) - activityRank(b);
  if (rank !== 0) return rank;
  if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
};

const compareByActivity = (a: TreeNode, b: TreeNode): number => {
  if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity;
  return a.label.localeCompare(b.label);
};

type Container = {
  key: NodeKey;
  sessions: Session[];
  folderScopeKey: string | null;
};

type Builder = {
  input: WorkspaceTreeInput;
  parents: Map<NodeKey, NodeKey>;
  placement: Map<string, NodeKey>;
};

const linkChildren = (builder: Builder, node: TreeNode): TreeNode => {
  for (const child of node.children) builder.parents.set(child.key, node.key);
  return node;
};

/** Session nodes with forks nested under their parent; forks whose parent is outside the container stay roots. */
const buildSessionForest = (builder: Builder, sessions: readonly Session[]): TreeNode[] => {
  const { input } = builder;
  const ids = new Set(sessions.map((session) => session.id));
  const childrenByParent = new Map<string, Session[]>();
  const roots: Session[] = [];
  for (const session of sessions) {
    const parentId = session.parentID ?? null;
    if (parentId && parentId !== session.id && ids.has(parentId)) {
      const list = childrenByParent.get(parentId);
      if (list) list.push(session);
      else childrenByParent.set(parentId, [session]);
    } else {
      roots.push(session);
    }
  }

  const visiting = new Set<string>();
  const toNode = (session: Session): TreeNode => {
    visiting.add(session.id);
    const forks = (childrenByParent.get(session.id) ?? []).filter((fork) => !visiting.has(fork.id));
    const children = forks.map(toNode).sort(compareSessionNodes);
    const activity = input.activity.get(session.id);
    const rollup: TreeRollup = {
      running: activity === 'running',
      waiting: activity === 'waiting',
      unseen: input.unseen.has(session.id),
    };
    let sessionCount = 0;
    let lastActivity = sessionActivityTime(session);
    for (const child of children) {
      mergeRollup(rollup, child.rollup);
      sessionCount += 1 + child.sessionCount;
      lastActivity = Math.max(lastActivity, child.lastActivity);
    }
    return linkChildren(builder, {
      key: `s:${session.id}`,
      kind: 'session',
      label: session.title ?? '',
      children,
      sessionCount,
      forkCount: children.length,
      lastActivity,
      rollup,
      session,
      pinned: input.isPinned(session),
    });
  };

  // A parent cycle has no root; break it at its first member so every session still appears.
  const placed = new Set<string>();
  const markPlaced = (node: TreeNode): void => {
    if (node.session) placed.add(node.session.id);
    node.children.forEach(markPlaced);
  };
  const forest = roots.map(toNode);
  forest.forEach(markPlaced);
  for (const session of sessions) {
    if (placed.has(session.id)) continue;
    const node = toNode(session);
    markPlaced(node);
    forest.push(node);
  }
  return forest.sort(compareSessionNodes);
};

const withMoreCut = (containerKey: NodeKey, nodes: TreeNode[]): TreeNode[] => {
  if (nodes.length <= SESSIONS_BEFORE_MORE) return nodes;
  const visible = nodes.slice(0, SESSIONS_BEFORE_MORE);
  const more = summarize({
    key: `more:${containerKey}`,
    kind: 'more',
    label: '',
    children: nodes.slice(SESSIONS_BEFORE_MORE),
    sessionCount: 0,
    forkCount: 0,
    lastActivity: 0,
    rollup: { ...EMPTY_ROLLUP },
  });
  return [...visible, more];
};

/** Loose sessions first (cut after five), then session folders in creation order. */
const buildContainerChildren = (builder: Builder, container: Container): TreeNode[] => {
  for (const session of container.sessions) builder.placement.set(session.id, container.key);
  const forest = buildSessionForest(builder, container.sessions);
  const folders = container.folderScopeKey ? builder.input.foldersByScope[container.folderScopeKey] ?? [] : [];
  if (folders.length === 0) {
    const children = withMoreCut(container.key, forest);
    children.forEach((child) => builder.parents.set(child.key, container.key));
    return children;
  }

  const scopeKey = container.folderScopeKey as string;
  const folderIds = new Set(folders.map((folder) => folder.id));
  const folderOfSession = new Map<string, string>();
  for (const folder of folders) {
    for (const sessionId of folder.sessionIds) {
      if (!folderOfSession.has(sessionId)) folderOfSession.set(sessionId, folder.id);
    }
  }
  const loose: TreeNode[] = [];
  const sessionsByFolder = new Map<string, TreeNode[]>();
  for (const node of forest) {
    const folderId = node.session ? folderOfSession.get(node.session.id) : undefined;
    if (!folderId) {
      loose.push(node);
      continue;
    }
    const list = sessionsByFolder.get(folderId);
    if (list) list.push(node);
    else sessionsByFolder.set(folderId, [node]);
  }

  const subfolders = new Map<string | null, SessionFolder[]>();
  for (const folder of folders) {
    const parentId = folder.parentId && folderIds.has(folder.parentId) && folder.parentId !== folder.id ? folder.parentId : null;
    const list = subfolders.get(parentId);
    if (list) list.push(folder);
    else subfolders.set(parentId, [folder]);
  }

  const visitingFolders = new Set<string>();
  const folderNode = (folder: SessionFolder): TreeNode => {
    visitingFolders.add(folder.id);
    const key: NodeKey = `f:${scopeKey}:${folder.id}`;
    const nested = (subfolders.get(folder.id) ?? [])
      .filter((child) => !visitingFolders.has(child.id))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(folderNode);
    const node = summarize({
      key,
      kind: 'folder',
      label: folder.name,
      children: [...withMoreCut(key, sessionsByFolder.get(folder.id) ?? []), ...nested],
      sessionCount: 0,
      forkCount: 0,
      lastActivity: 0,
      rollup: { ...EMPTY_ROLLUP },
      folderScopeKey: scopeKey,
    });
    return linkChildren(builder, node);
  };

  const topFolders = (subfolders.get(null) ?? []).sort((a, b) => a.createdAt - b.createdAt).map(folderNode);
  // Folders whose parent chain is a cycle never become top level; attach them so their sessions stay reachable.
  for (const folder of folders) {
    if (!visitingFolders.has(folder.id)) topFolders.push(folderNode(folder));
  }
  const children = [...withMoreCut(container.key, loose), ...topFolders];
  children.forEach((child) => builder.parents.set(child.key, container.key));
  return children;
};

const containerNode = (
  builder: Builder,
  container: Container,
  shape: Omit<TreeNode, 'children' | 'sessionCount' | 'forkCount' | 'lastActivity' | 'rollup'>,
): TreeNode => summarize({
  ...shape,
  children: buildContainerChildren(builder, container),
  sessionCount: 0,
  forkCount: 0,
  lastActivity: 0,
  rollup: { ...EMPTY_ROLLUP },
});

export const buildWorkspaceTree = (input: WorkspaceTreeInput): WorkspaceTree => {
  const builder: Builder = { input, parents: new Map(), placement: new Map() };
  const ownedById = input.ownership.bySessionId;
  const globalIds = new Set(input.ownership.globalSessions.map((session) => session.id));
  const active = input.sessions.filter((session) => !session.time?.archived);

  type ProjectBucket = {
    project: WorkspaceTreeProject;
    root: string;
    primary: GitWorktree | undefined;
    linked: Map<string, GitWorktree | undefined>;
    sessionsByScope: Map<string, Session[]>;
  };

  const buckets = new Map<string, ProjectBucket>();
  for (const project of input.projects) {
    const root = normalizePath(project.root) ?? project.root;
    const linked = new Map<string, GitWorktree | undefined>();
    let primary: GitWorktree | undefined;
    for (const worktree of input.worktreesByProject.get(project.id) ?? []) {
      const path = normalizePath(worktree.path);
      if (!path) continue;
      if (worktree.isPrimary || path === root) primary = worktree;
      else linked.set(path, worktree);
    }
    buckets.set(project.id, { project, root, primary, linked, sessionsByScope: new Map() });
  }

  const chats: Session[] = [];
  const unowned: Session[] = [];
  for (const session of active) {
    const owner = ownedById.get(session.id);
    const bucket = owner ? buckets.get(owner.projectId) : undefined;
    if (owner && bucket) {
      const scope = normalizePath(owner.scopeDirectory) ?? owner.scopeDirectory;
      if (scope !== bucket.root && !bucket.linked.has(scope)) bucket.linked.set(scope, undefined);
      const list = bucket.sessionsByScope.get(scope);
      if (list) list.push(session);
      else bucket.sessionsByScope.set(scope, [session]);
      continue;
    }
    if (globalIds.has(session.id)) chats.push(session);
    else unowned.push(session);
  }

  const isFlat = (bucket: ProjectBucket): boolean => bucket.linked.size === 0;

  // While discovery is incomplete, an ownerless session stays in the container it was in before.
  const stillOther: Session[] = [];
  for (const session of unowned) {
    const container = input.discoveryComplete ? undefined : input.previous?.placement.get(session.id);
    let projectKey: NodeKey | undefined = container;
    while (projectKey && !projectKey.startsWith('p:')) projectKey = input.previous?.parents.get(projectKey);
    const bucketForPrevious = projectKey ? buckets.get(projectKey.slice(2)) : undefined;
    const scope = container?.startsWith('w:') ? container.slice(2) : bucketForPrevious?.root;
    if (!bucketForPrevious || !scope) {
      stillOther.push(session);
      continue;
    }
    if (scope !== bucketForPrevious.root && !bucketForPrevious.linked.has(scope)) bucketForPrevious.linked.set(scope, undefined);
    const list = bucketForPrevious.sessionsByScope.get(scope);
    if (list) list.push(session);
    else bucketForPrevious.sessionsByScope.set(scope, [session]);
  }

  const roots: TreeNode[] = [];

  roots.push(containerNode(builder, { key: 'chats', sessions: chats, folderScopeKey: null }, {
    key: 'chats',
    kind: 'chats',
    label: '',
    directory: '~',
  }));

  for (const bucket of buckets.values()) {
    const { project, root } = bucket;
    const projectKey: NodeKey = `p:${project.id}`;
    if (isFlat(bucket)) {
      roots.push(containerNode(builder, {
        key: projectKey,
        sessions: bucket.sessionsByScope.get(root) ?? [],
        folderScopeKey: root,
      }, {
        key: projectKey,
        kind: 'project',
        label: project.label,
        projectId: project.id,
        directory: root,
        folderScopeKey: root,
        worktree: bucket.primary,
      }));
      continue;
    }

    const worktreeNode = (path: string, worktree: GitWorktree | undefined, primary: boolean): TreeNode => {
      const key: NodeKey = `w:${path}`;
      return containerNode(builder, {
        key,
        sessions: bucket.sessionsByScope.get(path) ?? [],
        folderScopeKey: path,
      }, {
        key,
        kind: 'worktree',
        label: worktree?.branch || worktree?.name || (primary ? 'main' : baseName(path)),
        projectId: project.id,
        directory: path,
        folderScopeKey: path,
        worktree,
      });
    };

    const primaryNode = worktreeNode(root, bucket.primary, true);
    const linked: TreeNode[] = [];
    const merged: TreeNode[] = [];
    for (const [path, worktree] of bucket.linked) {
      const node = worktreeNode(path, worktree, false);
      if (input.mergedWorktrees?.has(path)) merged.push(node);
      else linked.push(node);
    }
    linked.sort(compareByActivity);
    merged.sort(compareByActivity);
    const children = [primaryNode, ...linked];
    if (merged.length > 0) {
      const mergedKey: NodeKey = `merged:${project.id}`;
      children.push(linkChildren(builder, summarize({
        key: mergedKey,
        kind: 'merged',
        label: '',
        children: merged,
        sessionCount: 0,
        forkCount: 0,
        lastActivity: 0,
        rollup: { ...EMPTY_ROLLUP },
        projectId: project.id,
      })));
    }
    roots.push(linkChildren(builder, summarize({
      key: projectKey,
      kind: 'project',
      label: project.label,
      children,
      sessionCount: 0,
      forkCount: 0,
      lastActivity: 0,
      rollup: { ...EMPTY_ROLLUP },
      projectId: project.id,
      directory: root,
    })));
  }

  if (stillOther.length > 0) {
    const byDirectory = new Map<string, Session[]>();
    for (const session of stillOther) {
      const directory = sessionDirectory(session) ?? '';
      const list = byDirectory.get(directory);
      if (list) list.push(session);
      else byDirectory.set(directory, [session]);
    }
    const folders = [...byDirectory].map(([directory, sessions]) => {
      const key: NodeKey = `o:${directory}`;
      return containerNode(builder, { key, sessions, folderScopeKey: null }, {
        key,
        kind: 'otherFolder',
        label: directory,
        directory: directory || undefined,
      });
    }).sort(compareByActivity);
    roots.push(linkChildren(builder, summarize({
      key: 'other',
      kind: 'other',
      label: '',
      children: folders,
      sessionCount: 0,
      forkCount: 0,
      lastActivity: 0,
      rollup: { ...EMPTY_ROLLUP },
    })));
  }

  return {
    roots,
    sessionCount: roots.reduce((sum, node) => sum + node.sessionCount, 0),
    parents: builder.parents,
    placement: builder.placement,
  };
};

/** The project and worktree of the active session are open; everything else and all forks are closed. */
export const defaultExpanded = (tree: WorkspaceTree, activeSessionId: string | null): Set<NodeKey> => {
  const expanded = new Set<NodeKey>();
  if (!activeSessionId) return expanded;
  let current = tree.parents.get(`s:${activeSessionId}`);
  while (current) {
    expanded.add(current);
    current = tree.parents.get(current);
  }
  return expanded;
};

/**
 * Rows to render, top to bottom. A `more:` key in `revealedMore` shows its sessions in
 * place of the "N more" row; that reveal is transient and never persisted.
 */
export const visibleRows = (
  tree: WorkspaceTree,
  expanded: ReadonlySet<NodeKey>,
  revealedMore: ReadonlySet<NodeKey> = new Set(),
): TreeRow[] => {
  const rows: TreeRow[] = [];
  const visit = (nodes: readonly TreeNode[], depth: number, guides: boolean[]): void => {
    const flattened: TreeNode[] = [];
    for (const node of nodes) {
      if (node.kind === 'more' && revealedMore.has(node.key)) flattened.push(...node.children);
      else flattened.push(node);
    }
    flattened.forEach((node, index) => {
      const isLast = index === flattened.length - 1;
      const isOpen = node.kind !== 'more' && node.children.length > 0 && expanded.has(node.key);
      rows.push({ key: node.key, depth, node, expanded: isOpen, guides, isLast });
      if (isOpen) visit(node.children, depth + 1, [...guides, !isLast]);
    });
  };
  visit(tree.roots, 0, []);
  return rows;
};

const FIXED_LABELS: Partial<Record<TreeNodeKind, string>> = {
  chats: 'Chats',
  other: 'Other folders',
};

/** Plain text rendering for tests and reviews; not used by the UI. */
export const formatTreeAsText = (rows: readonly TreeRow[]): string => rows.map(({ node, depth, expanded }) => {
  const indent = '  '.repeat(depth);
  if (node.kind === 'more') return `${indent}… ${node.children.length} more`;
  if (node.kind === 'merged') return `${indent}${expanded ? '▾' : '▸'} ${node.children.length} merged`;
  const marker = node.children.length === 0 ? '' : expanded ? '▾ ' : '▸ ';
  const label = FIXED_LABELS[node.kind] ?? (node.label || '(untitled)');
  const parts = [`${indent}${marker}${label}`];
  if (node.kind !== 'session') parts.push(String(node.sessionCount));
  if (node.forkCount > 0) parts.push(`⑂${node.forkCount}`);
  const flags = [
    node.rollup.running ? 'running' : null,
    !node.rollup.running && node.rollup.waiting ? 'waiting' : null,
    node.pinned ? 'pinned' : null,
    node.rollup.unseen ? 'unseen' : null,
  ].filter(Boolean);
  if (flags.length > 0) parts.push(`[${flags.join(', ')}]`);
  return parts.join('  ');
}).join('\n');
