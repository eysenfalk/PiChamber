import type { NodeKey, TreeRow } from './workspaceTree';

export type TreeKeyAction =
  | { type: 'focus'; key: NodeKey }
  | { type: 'expand'; key: NodeKey }
  | { type: 'collapse'; key: NodeKey }
  | { type: 'activate'; key: NodeKey }
  | { type: 'newSession'; key: NodeKey };

type Args = {
  /** Visible rows, top to bottom. */
  rows: readonly TreeRow[];
  parents: ReadonlyMap<NodeKey, NodeKey>;
  focusedKey: NodeKey;
  key: string;
};

const canExpand = (row: TreeRow): boolean => row.node.kind !== 'more' && row.node.children.length > 0;

/** Rows that accept a new session: Chats, a project and a worktree. */
const canStartSession = (row: TreeRow): boolean => (
  (row.node.kind === 'chats' || row.node.kind === 'project' || row.node.kind === 'worktree') && Boolean(row.node.directory)
);

/**
 * Maps a key press on the focused tree row to one action. Pure: the tree
 * component decides how to carry the action out, and ignores key presses that
 * did not start on the row itself.
 */
export const resolveTreeKey = ({ rows, parents, focusedKey, key }: Args): TreeKeyAction | null => {
  const index = rows.findIndex((row) => row.key === focusedKey);
  if (index < 0) return null;
  const row = rows[index];
  const focusAt = (target: number): TreeKeyAction | null => {
    const next = rows[Math.max(0, Math.min(rows.length - 1, target))];
    return next && next.key !== focusedKey ? { type: 'focus', key: next.key } : null;
  };

  switch (key) {
    case 'ArrowDown':
      return focusAt(index + 1);
    case 'ArrowUp':
      return focusAt(index - 1);
    case 'Home':
      return focusAt(0);
    case 'End':
      return focusAt(rows.length - 1);
    case 'ArrowRight': {
      if (!canExpand(row)) return null;
      if (!row.expanded) return { type: 'expand', key: row.key };
      const first = rows[index + 1];
      return first && first.depth > row.depth ? { type: 'focus', key: first.key } : null;
    }
    case 'ArrowLeft': {
      if (canExpand(row) && row.expanded) return { type: 'collapse', key: row.key };
      // A revealed "N more" group has no row of its own; climb to the nearest visible ancestor.
      const visible = new Set(rows.map((entry) => entry.key));
      for (let parent = parents.get(row.key); parent; parent = parents.get(parent)) {
        if (visible.has(parent)) return { type: 'focus', key: parent };
      }
      return null;
    }
    case 'Enter':
      return { type: 'activate', key: row.key };
    case 'n':
      return canStartSession(row) ? { type: 'newSession', key: row.key } : null;
    default:
      return null;
  }
};
