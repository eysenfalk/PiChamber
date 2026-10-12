import React from 'react';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { defaultExpanded, type NodeKey, type WorkspaceTree } from '../workspaceTree';

const STORAGE_KEY = 'oc.sidebar.tree.expanded.v1';

const readStored = (): Set<NodeKey> | null => {
  try {
    const raw = getDeferredSafeStorage().getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.filter((item): item is NodeKey => typeof item === 'string'));
  } catch {
    return null;
  }
};

/**
 * The single writer of tree expansion. Stored per device only. Without a
 * stored value the model's `defaultExpanded` applies once the tree has
 * sessions; when the active session changes, its ancestors open once, and
 * closing them afterwards sticks.
 */
export const useWorkspaceTreeExpansion = (tree: WorkspaceTree, activeSessionId: string | null) => {
  const [expanded, setExpanded] = React.useState<Set<NodeKey> | null>(readStored);
  const revealedForRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (expanded !== null || tree.sessionCount === 0) return;
    setExpanded(defaultExpanded(tree, activeSessionId));
    revealedForRef.current = activeSessionId;
  }, [activeSessionId, expanded, tree]);

  React.useEffect(() => {
    if (!activeSessionId || revealedForRef.current === activeSessionId) return;
    if (!tree.placement.has(activeSessionId)) return;
    revealedForRef.current = activeSessionId;
    const ancestors = defaultExpanded(tree, activeSessionId);
    setExpanded((previous) => {
      const base = previous ?? new Set<NodeKey>();
      if ([...ancestors].every((key) => base.has(key))) return previous ?? base;
      return new Set([...base, ...ancestors]);
    });
  }, [activeSessionId, tree]);

  React.useEffect(() => {
    if (expanded === null) return;
    try {
      getDeferredSafeStorage().setItem(STORAGE_KEY, JSON.stringify([...expanded]));
    } catch {
      // Storage is best effort; the tree keeps working in memory.
    }
  }, [expanded]);

  const setOpen = React.useCallback((key: NodeKey, open: boolean) => {
    setExpanded((previous) => {
      const base = previous ?? new Set<NodeKey>();
      if (base.has(key) === open) return previous ?? base;
      const next = new Set(base);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  return { expanded: expanded ?? EMPTY, setOpen };
};

const EMPTY: ReadonlySet<NodeKey> = new Set();
