import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { GitWorktree } from '@/lib/api/types';
import { useDeviceInfo } from '@/lib/device';
import { applyTreeDrop } from './applyTreeDrop';
import { ContainerRow, TreeGuides } from './TreeContainerRow';
import { nodeLabel } from './treeNodeLabel';
import { TreeDndItem, TreeDndProvider, type TreeDragPayload } from './treeDnd';
import type { TreeDropData } from './treeDrop';
import { buildTreeNodeMenu, type TreeFolderActions } from './treeNodeMenu';
import { useTreeKeyboard } from './hooks/useTreeKeyboard';
import type { SessionNode } from './types';
import { sidebarRowLabelClass } from './utils';
import {
  visibleRows,
  type NodeKey,
  type TreeNode,
  type TreeRow,
  type WorkspaceTree as WorkspaceTreeModel,
} from './workspaceTree';

type RenderTreeSession = (
  node: SessionNode,
  directory: string | null,
  projectId: string | null,
) => React.ReactNode;

type Props = {
  tree: WorkspaceTreeModel;
  expanded: ReadonlySet<NodeKey>;
  setOpen: (key: NodeKey, open: boolean) => void;
  selectedNodeKey: string | null;
  onSelectNode: (key: NodeKey) => void;
  activeSessionId: string | null;
  renderSession: RenderTreeSession;
  onOpenSession: (sessionId: string, directory: string | null) => void;
  onNewSessionIn: (node: TreeNode) => void;
  folders: TreeFolderActions;
  onOpenProjectEditDialog: (projectId: string) => void;
  onRemoveProject: (projectId: string) => void;
  onCloseWorktree: (projectId: string, worktree: GitWorktree) => void;
  onOpenDirectoryDialog?: () => void;
  emptyState?: React.ReactNode;
  mobileVariant: boolean;
};

/** SessionNodeItem consumes the older SessionNode shape; build it once per tree node. */
const sessionNodeCache = new WeakMap<TreeNode, SessionNode>();
const toSessionNode = (node: TreeNode): SessionNode => {
  const cached = sessionNodeCache.get(node);
  if (cached) return cached;
  const converted: SessionNode = {
    session: node.session!,
    children: node.children.filter((child) => child.session).map(toSessionNode),
  };
  sessionNodeCache.set(node, converted);
  return converted;
};

/** Sessions open in their container's directory; Chats and ownerless containers have none. */
const containerDirectory = (container: TreeNode | undefined): string | null => (
  container?.directory && container.directory !== '~' ? container.directory : null
);

const dropDataOf = (node: TreeNode): TreeDropData | null => {
  if (node.kind !== 'project' && node.kind !== 'worktree' && node.kind !== 'folder') return null;
  return {
    key: node.key,
    scopeKey: node.folderScopeKey ?? null,
    folderId: node.kind === 'folder' ? node.folderId ?? null : null,
    projectId: node.kind === 'project' ? node.projectId ?? null : null,
  };
};

const dragPayloadOf = (node: TreeNode, container: TreeNode | undefined): TreeDragPayload | null => {
  if (node.kind === 'session' && node.session) {
    return {
      type: 'session',
      sessionId: node.session.id,
      scopeKey: container?.folderScopeKey ?? null,
      label: node.session.title || 'Untitled session',
    };
  }
  if (node.kind === 'folder' && node.folderId && node.folderScopeKey) {
    return { type: 'folder', key: node.key, folderId: node.folderId, scopeKey: node.folderScopeKey, label: node.label };
  }
  if (node.kind === 'project' && node.projectId) {
    return { type: 'project', projectId: node.projectId, label: node.label };
  }
  return null;
};

/**
 * The sidebar workspace tree: one list for Chats, projects, worktrees, folders
 * and sessions. Rows only render what `buildWorkspaceTree` produced; selection
 * marks where new sessions land and never filters the tree. Rows drag and drop
 * through `TreeDndProvider` and take arrow keys through `useTreeKeyboard`.
 */
export const SidebarWorkspaceTree: React.FC<Props> = ({
  tree,
  expanded,
  setOpen,
  selectedNodeKey,
  onSelectNode,
  activeSessionId,
  renderSession,
  onOpenSession,
  onNewSessionIn,
  folders,
  onOpenProjectEditDialog,
  onRemoveProject,
  onCloseWorktree,
  onOpenDirectoryDialog,
  emptyState,
  mobileVariant,
}) => {
  const { hasTouchOnlyPointer } = useDeviceInfo();
  const [revealedMore, setRevealedMore] = React.useState<ReadonlySet<NodeKey>>(() => new Set());

  const activeMoreKey = React.useMemo(() => {
    if (!activeSessionId) return null;
    const parent = tree.parents.get(`s:${activeSessionId}`);
    return parent?.startsWith('more:') ? parent : null;
  }, [activeSessionId, tree]);

  const rows = React.useMemo(() => {
    const revealed = activeMoreKey && !revealedMore.has(activeMoreKey)
      ? new Set([...revealedMore, activeMoreKey])
      : revealedMore;
    return visibleRows(tree, expanded, revealed);
  }, [activeMoreKey, expanded, revealedMore, tree]);

  // A visible session row implies visible ancestors, so the row index finds its container.
  const rowNodeByKey = React.useMemo(() => new Map(rows.map((row) => [row.key, row.node])), [rows]);
  const projectOrder = React.useMemo(
    () => tree.roots.flatMap((root) => (root.kind === 'project' && root.projectId ? [root.projectId] : [])),
    [tree.roots],
  );

  const containerOf = (key: NodeKey): TreeNode | undefined => {
    let current = tree.parents.get(key);
    while (current) {
      const parent = rowNodeByKey.get(current);
      if (parent && parent.kind !== 'session' && parent.kind !== 'more' && parent.kind !== 'merged') return parent;
      current = tree.parents.get(current);
    }
    return undefined;
  };

  const handleToggle = React.useCallback((row: TreeRow) => {
    setOpen(row.key, !row.expanded);
  }, [setOpen]);

  const handleActivate = React.useCallback((row: TreeRow) => {
    if (row.node.kind === 'more') {
      setRevealedMore((previous) => new Set([...previous, row.key]));
      return;
    }
    const expandable = row.node.children.length > 0;
    if (selectedNodeKey === row.key) {
      if (expandable) setOpen(row.key, !row.expanded);
      return;
    }
    onSelectNode(row.key);
    if (expandable && !row.expanded) setOpen(row.key, true);
  }, [onSelectNode, selectedNodeKey, setOpen]);

  const rowByKey = (key: NodeKey): TreeRow | undefined => rows.find((row) => row.key === key);

  const { itemProps } = useTreeKeyboard({
    rows,
    parents: tree.parents,
    onAction: (action) => {
      const row = rowByKey(action.key);
      if (!row) return;
      if (action.type === 'expand') setOpen(action.key, true);
      else if (action.type === 'collapse') setOpen(action.key, false);
      else if (action.type === 'newSession') onNewSessionIn(row.node);
      else if (row.node.kind === 'session' && row.node.session) {
        onOpenSession(row.node.session.id, containerDirectory(containerOf(row.key)));
      } else handleActivate(row);
    },
  });

  const createFolderIn = (node: TreeNode) => {
    if (!node.folderScopeKey) return;
    // The new folder's name field lives inside the row's children, so open them.
    setOpen(node.key, true);
    folders.onCreateFolder(node.folderScopeKey, node.kind === 'folder' ? node.folderId ?? null : null);
  };

  const menuFor = (node: TreeNode): React.ReactNode => buildTreeNodeMenu(node, {
    folders,
    onCreateFolder: createFolderIn,
    onOpenProjectEditDialog,
    onRemoveProject,
    onCloseWorktree,
  });

  const renameFor = (node: TreeNode) => (
    node.kind === 'folder' && node.folderId && node.folderId === folders.renamingFolderId
      ? {
          value: folders.renameDraft,
          onChange: folders.onRenameDraftChange,
          onSave: () => folders.onSaveRename(node),
          onCancel: folders.onCancelRename,
        }
      : undefined
  );

  const treeItemClass = 'rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50';

  return (
    <TreeDndProvider
      parents={tree.parents}
      projectOrder={projectOrder}
      touchDrag={hasTouchOnlyPointer}
      onDrop={applyTreeDrop}
    >
      <div role="tree" aria-label="Workspaces" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
        {tree.sessionCount === 0 && emptyState ? emptyState : null}
        {rows.map((row) => {
          const container = row.node.kind === 'session' ? containerOf(row.key) : undefined;
          const drag = dragPayloadOf(row.node, container);
          if (row.node.kind === 'session' && row.node.session) {
            const forks = row.node.children.length;
            return (
              <TreeDndItem key={row.key} nodeKey={row.key} drag={drag} drop={null} handleLabel="Drag to move session">
                <div
                  {...itemProps(row.key)}
                  role="treeitem"
                  data-tree-node={row.key}
                  aria-label={nodeLabel(row.node)}
                  aria-level={row.depth + 1}
                  aria-expanded={forks > 0 ? row.expanded : undefined}
                  className={`flex min-h-6 min-w-0 items-center ${treeItemClass}`}
                >
                  <TreeGuides row={row} />
                  {forks > 0 ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      data-tree-toggle=""
                      onClick={() => handleToggle(row)}
                      aria-label={row.expanded ? 'Collapse forks' : 'Expand forks'}
                      className="inline-flex h-4 !min-h-0 w-4 !min-w-0 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
                    >
                      <Icon name={row.expanded ? 'arrow-down-s' : 'arrow-right-s'} className="h-3 w-3" />
                    </button>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    {renderSession(toSessionNode(row.node), containerDirectory(container), container?.projectId ?? null)}
                  </div>
                  {forks > 0 ? (
                    <span className="shrink-0 pl-1 typography-micro tabular-nums text-muted-foreground" aria-label={forks === 1 ? '1 fork' : `${forks} forks`}>
                      {`⑂${forks}`}
                    </span>
                  ) : null}
                </div>
              </TreeDndItem>
            );
          }
          return (
            <TreeDndItem
              key={row.key}
              nodeKey={row.key}
              drag={drag}
              drop={dropDataOf(row.node)}
              handleLabel={row.node.kind === 'project' ? 'Drag to reorder folder' : 'Drag to move folder'}
            >
              <div
                {...itemProps(row.key)}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={row.node.children.length > 0 ? row.expanded : undefined}
                aria-label={row.node.kind === 'folder' ? row.node.label : undefined}
                className={treeItemClass}
              >
                <ContainerRow
                  row={row}
                  selected={selectedNodeKey === row.key}
                  onActivate={handleActivate}
                  onToggle={handleToggle}
                  menu={menuFor(row.node)}
                  rename={renameFor(row.node)}
                  mobileVariant={mobileVariant}
                />
              </div>
            </TreeDndItem>
          );
        })}
        {onOpenDirectoryDialog ? (
          <button
            type="button"
            onClick={onOpenDirectoryDialog}
            className="mt-1 flex h-6 w-full items-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            <span className="inline-flex h-4 w-4 shrink-0" />
            <Icon name="add" className="size-3.5 shrink-0" />
            <span className={sidebarRowLabelClass(mobileVariant)}>{'Add folder'}</span>
          </button>
        ) : null}
      </div>
    </TreeDndProvider>
  );
};
