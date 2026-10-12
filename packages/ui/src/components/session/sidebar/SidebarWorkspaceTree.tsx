import React from 'react';
import { AgentThinkingLoader } from '@/components/chat/AgentThinkingLoader';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import type { GitWorktree } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { SessionUnreadDot } from './SessionUnreadDot';
import type { SessionNode } from './types';
import { useLongPressMenu } from './hooks/useLongPressMenu';
import { sidebarRowLabelClass } from './utils';
import {
  visibleRows,
  type NodeKey,
  type TreeNode,
  type TreeNodeKind,
  type TreeRow,
  type WorkspaceTree as WorkspaceTreeModel,
} from './workspaceTree';

export type RenderTreeSession = (
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
  onOpenProjectEditDialog: (projectId: string) => void;
  onRemoveProject: (projectId: string) => void;
  onCloseWorktree: (projectId: string, worktree: GitWorktree) => void;
  onOpenDirectoryDialog?: () => void;
  emptyState?: React.ReactNode;
  mobileVariant: boolean;
};

const GUIDE_WIDTH_PX = 12;

const KIND_ICON: Record<Exclude<TreeNodeKind, 'session'>, IconName> = {
  chats: 'chat-3',
  project: 'folder-3',
  worktree: 'git-branch',
  folder: 'folder',
  more: 'more',
  merged: 'git-merge',
  other: 'folders',
  otherFolder: 'folder',
};

const nodeLabel = (node: TreeNode): string => {
  switch (node.kind) {
    case 'chats':
      return 'Chats';
    case 'other':
      return 'Other folders';
    case 'more':
      return `${node.children.length} more`;
    case 'merged':
      return `${node.children.length} merged`;
    default:
      return node.label;
  }
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

const Guides: React.FC<{ row: TreeRow }> = ({ row }) => {
  if (row.depth === 0) return null;
  return (
    <>
      {Array.from({ length: row.depth }, (_, level) => {
        const own = level === row.depth - 1;
        const line = own ? (row.isLast ? 'half' : 'full') : row.guides[level + 1] ? 'full' : null;
        return (
          <span key={level} aria-hidden className="relative shrink-0 self-stretch" style={{ width: GUIDE_WIDTH_PX }}>
            {line ? (
              <span
                className={cn('absolute left-1/2 w-px bg-border', line === 'full' ? 'inset-y-0' : 'top-0 h-1/2')}
              />
            ) : null}
          </span>
        );
      })}
    </>
  );
};

const CountSlot: React.FC<{ node: TreeNode; expanded: boolean }> = ({ node, expanded }) => {
  const showRunning = node.rollup.running && !expanded;
  const showUnseen = !showRunning && node.rollup.unseen && !expanded;
  return (
    <span className="ml-1 flex h-6 min-w-6 shrink-0 items-center justify-end gap-1 typography-micro text-muted-foreground">
      {showRunning ? (
        <AgentThinkingLoader
          variant="inline"
          text={null}
          animationType="spinner"
          speedMs={80}
          className="text-primary text-xs shrink-0"
        />
      ) : null}
      {showUnseen ? <SessionUnreadDot label="Unread sessions" /> : null}
      {node.kind !== 'more' && node.sessionCount > 0 ? <span className="tabular-nums">{node.sessionCount}</span> : null}
    </span>
  );
};

type ContainerRowProps = {
  row: TreeRow;
  selected: boolean;
  onActivate: (row: TreeRow) => void;
  onToggle: (row: TreeRow) => void;
  menu?: React.ReactNode;
  mobileVariant: boolean;
};

const ContainerRow: React.FC<ContainerRowProps> = ({ row, selected, onActivate, onToggle, menu, mobileVariant }) => {
  const { node } = row;
  const longPress = useLongPressMenu();
  const expandable = node.kind !== 'more' && node.children.length > 0;
  const label = nodeLabel(node);
  const icon = node.kind === 'session' ? null : KIND_ICON[node.kind];

  const body = (
    <>
      <Guides row={row} />
      {/* Pointer shortcut only: the row button carries aria-expanded and toggles on a second activation. */}
      <span
        aria-hidden="true"
        data-tree-toggle={expandable ? '' : undefined}
        onClick={expandable ? (event) => {
          event.stopPropagation();
          onToggle(row);
        } : undefined}
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
      >
        {expandable ? <Icon name={row.expanded ? 'arrow-down-s' : 'arrow-right-s'} className="h-3 w-3" /> : null}
      </span>
      {icon ? <Icon name={icon} className="size-3.5 shrink-0 text-muted-foreground" /> : null}
      <span className={cn(sidebarRowLabelClass(mobileVariant), 'flex-1 text-left', node.kind === 'more' && 'text-muted-foreground')}>
        {label}
      </span>
      <CountSlot node={node} expanded={row.expanded} />
    </>
  );

  const rowClass = cn(
    'flex min-h-6 w-full min-w-0 items-center gap-1 rounded-md px-1.5 text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
    selected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
  );

  const button = (
    <button
      type="button"
      data-tree-node={row.key}
      aria-expanded={expandable ? row.expanded : undefined}
      aria-current={selected ? 'true' : undefined}
      title={node.directory && node.directory !== '~' ? node.directory : undefined}
      onClick={() => {
        if (longPress.open) return;
        onActivate(row);
      }}
      {...(menu ? longPress.touchHandlers : {})}
      style={{ touchAction: 'manipulation' }}
      className={rowClass}
    />
  );

  if (!menu) {
    return React.cloneElement(button, undefined, body);
  }

  return (
    <ContextMenu open={longPress.open} onOpenChange={longPress.setOpen}>
      <ContextMenuTrigger render={button}>{body}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-[160px]">{menu}</ContextMenuContent>
    </ContextMenu>
  );
};

/**
 * The sidebar workspace tree: one list for Chats, projects, worktrees, folders
 * and sessions. Rows only render what `buildWorkspaceTree` produced; selection
 * marks where new sessions land and never filters the tree.
 */
export const SidebarWorkspaceTree: React.FC<Props> = ({
  tree,
  expanded,
  setOpen,
  selectedNodeKey,
  onSelectNode,
  activeSessionId,
  renderSession,
  onOpenProjectEditDialog,
  onRemoveProject,
  onCloseWorktree,
  onOpenDirectoryDialog,
  emptyState,
  mobileVariant,
}) => {
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

  const menuFor = (node: TreeNode): React.ReactNode => {
    if (node.kind === 'project' && node.projectId) {
      const projectId = node.projectId;
      return (
        <>
          <ContextMenuItem onClick={() => onOpenProjectEditDialog(projectId)}>
            <Icon name="edit" className="mr-2 h-3.5 w-3.5" />
            <span>{'Edit folder'}</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onRemoveProject(projectId)} className="text-destructive focus:text-destructive">
            <Icon name="close" className="mr-2 h-3.5 w-3.5" />
            <span>{'Close folder'}</span>
          </ContextMenuItem>
        </>
      );
    }
    if (node.kind === 'worktree' && node.projectId && node.worktree) {
      const projectId = node.projectId;
      const worktree = node.worktree;
      return (
        <ContextMenuItem
          title={node.rollup.running ? 'Stop the active session before closing this worktree.' : undefined}
          onClick={() => onCloseWorktree(projectId, worktree)}
          className="text-destructive focus:text-destructive"
        >
          <Icon name="close" className="mr-2 h-3.5 w-3.5" />
          <span>{'Close worktree'}</span>
        </ContextMenuItem>
      );
    }
    return undefined;
  };

  const containerOf = (key: NodeKey): TreeNode | undefined => {
    let current = tree.parents.get(key);
    while (current) {
      const parent = rowNodeByKey.get(current);
      if (parent && parent.kind !== 'session' && parent.kind !== 'more' && parent.kind !== 'merged') return parent;
      current = tree.parents.get(current);
    }
    return undefined;
  };

  return (
    <div role="tree" aria-label="Workspaces" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
      {tree.sessionCount === 0 && emptyState ? emptyState : null}
      {rows.map((row) => {
        if (row.node.kind === 'session' && row.node.session) {
          const container = containerOf(row.key);
          const forks = row.node.children.length;
          return (
            <div
              key={row.key}
              role="treeitem"
              data-tree-node={row.key}
              aria-label={nodeLabel(row.node)}
              aria-level={row.depth + 1}
              aria-expanded={forks > 0 ? row.expanded : undefined}
              className="flex min-h-6 min-w-0 items-center"
            >
              <Guides row={row} />
              {forks > 0 ? (
                <button
                  type="button"
                  data-tree-toggle=""
                  onClick={() => handleToggle(row)}
                  aria-label={row.expanded ? 'Collapse forks' : 'Expand forks'}
                  className="inline-flex h-4 !min-h-0 w-4 !min-w-0 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
                >
                  <Icon name={row.expanded ? 'arrow-down-s' : 'arrow-right-s'} className="h-3 w-3" />
                </button>
              ) : null}
              <div className="min-w-0 flex-1">
                {renderSession(
                  toSessionNode(row.node),
                  container?.directory && container.directory !== '~' ? container.directory : null,
                  container?.projectId ?? null,
                )}
              </div>
              {forks > 0 ? (
                <span className="shrink-0 pl-1 typography-micro tabular-nums text-muted-foreground" aria-label={forks === 1 ? '1 fork' : `${forks} forks`}>
                  {`⑂${forks}`}
                </span>
              ) : null}
            </div>
          );
        }
        return (
          <div key={row.key} role="treeitem" aria-level={row.depth + 1} aria-expanded={row.node.children.length > 0 ? row.expanded : undefined}>
            <ContainerRow
              row={row}
              selected={selectedNodeKey === row.key}
              onActivate={handleActivate}
              onToggle={handleToggle}
              menu={menuFor(row.node)}
              mobileVariant={mobileVariant}
            />
          </div>
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
  );
};
