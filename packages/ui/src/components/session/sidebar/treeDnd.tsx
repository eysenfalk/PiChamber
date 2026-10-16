import React from 'react';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';
import { resolveTreeDrop, type TreeDragData, type TreeDropAction, type TreeDropData } from './treeDrop';
import type { NodeKey } from './workspaceTree';

/** A drag payload plus the label shown on the drag overlay. */
export type TreeDragPayload = TreeDragData & { label: string };

type TreeDndContextValue = {
  active: TreeDragPayload | null;
  parents: ReadonlyMap<NodeKey, NodeKey>;
  /** Project ids in tree order, to tell which side of a project row a reorder lands on. */
  projectOrder: readonly string[];
  /** Touch devices drag from a handle only, because a press-and-hold on the row opens its context menu. */
  touchDrag: boolean;
};

const TreeDndContext = React.createContext<TreeDndContextValue | null>(null);

const OVERLAY_ICON: Record<TreeDragData['type'], IconName> = {
  session: 'chat-3',
  folder: 'folder',
  project: 'folder-3',
};

type ProviderProps = {
  parents: ReadonlyMap<NodeKey, NodeKey>;
  projectOrder: readonly string[];
  touchDrag: boolean;
  onDrop: (action: TreeDropAction) => void;
  children: React.ReactNode;
};

/** One drag and drop scope for the whole tree. Rows opt in through `TreeDndItem`. */
export const TreeDndProvider: React.FC<ProviderProps> = ({ parents, projectOrder, touchDrag, onDrop, children }) => {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );
  const [active, setActive] = React.useState<TreeDragPayload | null>(null);
  const [overlayWidth, setOverlayWidth] = React.useState<number | null>(null);

  const handleDragStart = (event: DragStartEvent) => {
    setActive(event.active.data.current as TreeDragPayload);
    setOverlayWidth(event.active.rect.current.initial?.width ?? null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActive(null);
    const { active: dragged, over } = event;
    if (!over) return;
    const action = resolveTreeDrop(
      dragged.data.current as TreeDragData,
      over.data.current as TreeDropData,
      parents,
    );
    if (action) onDrop(action);
  };

  const value = React.useMemo(
    () => ({ active, parents, projectOrder, touchDrag }),
    [active, parents, projectOrder, touchDrag],
  );

  return (
    <TreeDndContext.Provider value={value}>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragCancel={() => setActive(null)}
        onDragEnd={handleDragEnd}
      >
        {children}
        <DragOverlay>
          {active ? (
            <div
              style={overlayWidth ? { width: overlayWidth } : undefined}
              className="pointer-events-none flex min-h-6 items-center gap-1.5 rounded-md border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2 shadow-none"
            >
              <Icon name={OVERLAY_ICON[active.type]} className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">{active.label}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </TreeDndContext.Provider>
  );
};

type ItemProps = {
  nodeKey: NodeKey;
  /** What dragging this row moves; null when the row cannot be dragged. */
  drag: TreeDragPayload | null;
  /** What this row accepts; null when it is no drop target. */
  drop: TreeDropData | null;
  /** Aria label of the touch drag handle. */
  handleLabel: string;
  className?: string;
  children: React.ReactNode;
};

const isEditableTarget = (target: EventTarget): boolean => (
  target instanceof HTMLElement && target.closest('input, textarea, [contenteditable="true"]') !== null
);

/**
 * Wraps one tree row as draggable and/or drop target. A hovered target shows
 * its feedback only when `resolveTreeDrop` accepts the drag in progress.
 */
export const TreeDndItem: React.FC<ItemProps> = ({ nodeKey, drag, drop, handleLabel, className, children }) => {
  const dnd = React.useContext(TreeDndContext);
  const draggable = useDraggable({ id: nodeKey, data: drag ?? undefined, disabled: !drag });
  const droppable = useDroppable({ id: nodeKey, data: drop ?? undefined, disabled: !drop });
  const { setNodeRef: setDraggableRef } = draggable;
  const { setNodeRef: setDroppableRef } = droppable;
  const setNodeRef = React.useCallback((element: HTMLElement | null) => {
    setDraggableRef(element);
    setDroppableRef(element);
  }, [setDraggableRef, setDroppableRef]);

  const action = dnd?.active && drop && droppable.isOver ? resolveTreeDrop(dnd.active, drop, dnd.parents) : null;
  const reorderBelow = action?.type === 'reorderProject'
    && dnd !== null
    && dnd.projectOrder.indexOf(action.projectId) < dnd.projectOrder.indexOf(action.overProjectId);

  const { onMouseDown } = draggable.listeners ?? {};
  const rowListeners = drag && !dnd?.touchDrag && onMouseDown
    ? {
        onMouseDown: (event: React.MouseEvent) => {
          if (!isEditableTarget(event.target)) (onMouseDown as (event: React.MouseEvent) => void)(event);
        },
      }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      {...rowListeners}
      className={cn(
        'relative flex items-center',
        className,
        draggable.isDragging && 'opacity-40',
        action && action.type !== 'reorderProject' && 'rounded-md bg-interactive-hover ring-1 ring-primary/50',
      )}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {drag && dnd?.touchDrag ? (
        <button
          type="button"
          ref={draggable.setActivatorNodeRef}
          {...draggable.listeners}
          aria-label={handleLabel}
          tabIndex={-1}
          style={{ touchAction: 'none' }}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground"
        >
          <Icon name="draggable" className="size-3.5" />
        </button>
      ) : dnd?.touchDrag ? (
        // Keeps the count column aligned with rows that have a handle.
        <span aria-hidden className="h-6 w-6 shrink-0" />
      ) : null}
      {action?.type === 'reorderProject' ? (
        <span
          aria-hidden
          className={cn('pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-primary', reorderBelow ? 'bottom-0' : 'top-0')}
        />
      ) : null}
    </div>
  );
};
