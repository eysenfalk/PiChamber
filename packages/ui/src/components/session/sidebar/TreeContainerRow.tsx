import React from 'react';
import { AgentThinkingLoader } from '@/components/chat/AgentThinkingLoader';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import { renderHighlightedText } from './highlightedText';
import { SessionUnreadDot } from './SessionUnreadDot';
import { TreeFolderRename } from './TreeFolderRename';
import { nodeLabel } from './treeNodeLabel';
import { useLongPressMenu } from './hooks/useLongPressMenu';
import { sidebarRowLabelClass } from './utils';
import type { TreeNode, TreeNodeKind, TreeRow } from './workspaceTree';

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

/**
 * One span for all guide columns, so a flex gap in the row applies once and every
 * row kind indents exactly GUIDE_WIDTH_PX per level. Rendered empty at depth 0 for
 * the same reason.
 */
export const TreeGuides: React.FC<{ row: TreeRow }> = ({ row }) => {
  return (
    <span aria-hidden className="flex shrink-0 self-stretch">
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
    </span>
  );
};

/** A worker waits for an answer to its question (orchestration registry, #20). */
export const WaitingMarker: React.FC<{ label: string }> = ({ label }) => (
  <span role="img" aria-label={label} title={label} data-testid="waiting-marker" className="inline-flex shrink-0 items-center text-status-warning">
    <Icon name="question" className="size-3.5" />
  </span>
);

/**
 * With `quickCreate` the slot keeps its width and fades out while the row is
 * hovered or keyboard focused; the `+` button (`QuickCreateButton`) fades in over it.
 * The `treeitem` around the row is the `group/row`.
 */
const CountSlot: React.FC<{ node: TreeNode; expanded: boolean; quickCreate?: boolean }> = ({ node, expanded, quickCreate = false }) => {
  const showRunning = node.rollup.running && !expanded;
  const showWaiting = !node.rollup.running && node.rollup.waiting && !expanded;
  const showUnseen = !showRunning && !showWaiting && node.rollup.unseen && !expanded;
  return (
    <span
      className={cn(
        'ml-1 flex h-6 min-w-6 shrink-0 items-center justify-end gap-1 typography-micro text-muted-foreground',
        quickCreate && 'group-hover/row:opacity-0 group-focus-visible/row:opacity-0',
      )}
    >
      {showRunning ? (
        <AgentThinkingLoader
          variant="inline"
          text={null}
          animationType="spinner"
          speedMs={80}
          className="text-primary text-xs shrink-0"
        />
      ) : null}
      {showWaiting ? <WaitingMarker label="A worker is waiting for an answer" /> : null}
      {showUnseen ? <SessionUnreadDot label="Unread sessions" /> : null}
      {node.kind !== 'more' && node.sessionCount > 0 ? <span className="tabular-nums">{node.sessionCount}</span> : null}
    </span>
  );
};

/**
 * A sibling of the row button (a button inside a button is invalid), laid over the
 * count slot's box. It is a pointer shortcut: the row has no tab stop for it, and
 * keyboard users start a session with `n` or the row menu.
 */
const QuickCreateButton: React.FC<{ node: TreeNode; onQuickCreate: (node: TreeNode) => void }> = ({ node, onQuickCreate }) => (
  <button
    type="button"
    tabIndex={-1}
    aria-label={`New session in ${nodeLabel(node)}`}
    title="New session"
    onMouseDown={(event) => event.stopPropagation()}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => {
      event.stopPropagation();
      onQuickCreate(node);
    }}
    className="pointer-events-none absolute right-1.5 top-1/2 inline-flex size-6 !min-h-0 !min-w-0 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-interactive-hover hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-visible/row:pointer-events-auto group-focus-visible/row:opacity-100"
  >
    <Icon name="add" className="size-3.5" />
  </button>
);

type ContainerRowProps = {
  row: TreeRow;
  selected: boolean;
  onActivate: (row: TreeRow) => void;
  onToggle: (row: TreeRow) => void;
  menu?: React.ReactNode;
  /** Set while the folder behind this row is being renamed; the row then shows an input instead of a label. */
  rename?: { value: string; onChange: (value: string) => void; onSave: () => void; onCancel: () => void };
  mobileVariant: boolean;
  query?: string;
  /** Git pills of a worktree, or the dirty rollup of a collapsed project. */
  git?: React.ReactNode;
  /** Set where the row offers the hover `+`; the caller decides which rows and devices. */
  onQuickCreate?: (node: TreeNode) => void;
};

/** Container rows are not tab stops: the `treeitem` around them carries the roving focus. */
export const ContainerRow: React.FC<ContainerRowProps> = ({ row, selected, onActivate, onToggle, menu, rename, mobileVariant, query = '', git, onQuickCreate }) => {
  const { node } = row;
  const longPress = useLongPressMenu();
  const expandable = node.kind !== 'more' && node.children.length > 0;
  const label = nodeLabel(node);
  const icon = node.kind === 'session' ? null : KIND_ICON[node.kind];

  const body = (
    <>
      <TreeGuides row={row} />
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
      {rename ? (
        <TreeFolderRename {...rename} />
      ) : (
        <>
          <span className={cn(sidebarRowLabelClass(mobileVariant), 'flex-1 text-left', node.kind === 'more' && 'text-muted-foreground')}>
            {node.kind === 'more' || node.kind === 'merged' ? label : renderHighlightedText(label, query)}
          </span>
          {node.hiddenMatch ? (
            <span role="img" aria-label="Hidden from the sidebar" title="Hidden from the sidebar" className="inline-flex shrink-0 items-center text-muted-foreground">
              <Icon name="eye-off" className="size-3" />
            </span>
          ) : null}
          {git}
          <CountSlot node={node} expanded={row.expanded} quickCreate={Boolean(onQuickCreate)} />
        </>
      )}
    </>
  );

  const rowClass = cn(
    // pl-0.5 plus the gap after the guides puts the chevron where session rows have theirs (pl-1.5).
    'flex min-h-6 w-full min-w-0 items-center gap-1 rounded-md pl-0.5 pr-1.5 text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
    selected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
  );

  if (rename) {
    return <div className={rowClass}>{body}</div>;
  }

  const button = (
    <button
      type="button"
      tabIndex={-1}
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

  const withQuickCreate = (element: React.ReactElement) => (onQuickCreate ? (
    <div className="relative">
      {element}
      <QuickCreateButton node={node} onQuickCreate={onQuickCreate} />
    </div>
  ) : element);

  if (!menu) {
    return withQuickCreate(React.cloneElement(button, undefined, body));
  }

  return withQuickCreate(
    <ContextMenu open={longPress.open} onOpenChange={longPress.setOpen}>
      <ContextMenuTrigger render={button}>{body}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-[160px]">{menu}</ContextMenuContent>
    </ContextMenu>,
  );
};
