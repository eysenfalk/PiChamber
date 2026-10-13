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
 *
 * While `query` is non-empty the tree shows the model's `searchExpanded`
 * overlay plus the toggles made during that query, and the stored expansion
 * stays untouched, so clearing the query restores the previous view.
 */
export const useWorkspaceTreeExpansion = (tree: WorkspaceTree, activeSessionId: string | null, query = '') => {
  const [expanded, setExpanded] = React.useState<Set<NodeKey> | null>(readStored);
  const [searchToggles, setSearchToggles] = React.useState<{ query: string; open: ReadonlyMap<NodeKey, boolean> } | null>(null);
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

  const searchView = React.useMemo(() => {
    if (!query) return null;
    const view = new Set(tree.searchExpanded);
    if (searchToggles?.query === query) {
      searchToggles.open.forEach((open, key) => (open ? view.add(key) : view.delete(key)));
    }
    return view;
  }, [query, searchToggles, tree.searchExpanded]);

  const setOpen = React.useCallback((key: NodeKey, open: boolean) => {
    if (query) {
      setSearchToggles((previous) => ({
        query,
        open: new Map(previous?.query === query ? previous.open : []).set(key, open),
      }));
      return;
    }
    setExpanded((previous) => {
      const base = previous ?? new Set<NodeKey>();
      if (base.has(key) === open) return previous ?? base;
      const next = new Set(base);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  }, [query]);

  return { expanded: searchView ?? expanded ?? EMPTY, setOpen };
};

const EMPTY: ReadonlySet<NodeKey> = new Set();
