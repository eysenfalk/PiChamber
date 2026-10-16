import React from 'react';
import { resolveTreeKey, type TreeKeyAction } from '../treeKeyboard';
import type { NodeKey, TreeRow } from '../workspaceTree';

type Args = {
  rows: readonly TreeRow[];
  parents: ReadonlyMap<NodeKey, NodeKey>;
  /** Called for every action except focus moves, which the hook carries out itself. */
  onAction: (action: Exclude<TreeKeyAction, { type: 'focus' }>) => void;
};

/**
 * Roving focus for the tree: one `treeitem` is the tab stop (the focused one,
 * the first row until something is focused), the rest take -1. Arrow keys,
 * Home and End also work from a button inside the row, so a mouse click on a
 * row can be followed by arrow keys; every other key acts only when it starts
 * on the treeitem itself, so inputs and buttons inside a row keep their own keys.
 */
const NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

const isTextEntry = (target: EventTarget): boolean => (
  target instanceof HTMLElement
  && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
);

export const useTreeKeyboard = ({ rows, parents, onAction }: Args) => {
  const [focusedKey, setFocusedKey] = React.useState<NodeKey | null>(null);
  const elements = React.useRef(new Map<NodeKey, HTMLElement>());

  const tabStopKey = focusedKey && rows.some((row) => row.key === focusedKey) ? focusedKey : rows[0]?.key ?? null;

  const itemProps = (key: NodeKey) => ({
    ref: (element: HTMLElement | null) => {
      if (element) elements.current.set(key, element);
      else elements.current.delete(key);
    },
    tabIndex: key === tabStopKey ? 0 : -1,
    onFocus: () => setFocusedKey(key),
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget && (!NAVIGATION_KEYS.has(event.key) || isTextEntry(event.target))) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const action = resolveTreeKey({ rows, parents, focusedKey: key, key: event.key });
      if (!action) return;
      event.preventDefault();
      if (action.type === 'focus') {
        setFocusedKey(action.key);
        elements.current.get(action.key)?.focus();
        return;
      }
      onAction(action);
    },
  });

  return { itemProps };
};
