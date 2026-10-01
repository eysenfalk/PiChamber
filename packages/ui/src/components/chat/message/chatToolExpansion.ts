export const EXPANDED_TOOLS_CACHE_MAX = 4000;

/**
 * Per message: the tool ids the user flipped away from the default, tagged with
 * the default they were flipped from. Flips made while tools opened closed mean
 * the opposite of flips made while "expand all" was on, so a record from the
 * other default is ignored instead of misread.
 */
export const expandedToolsStateCache = new Map<string, { expandAll: boolean; ids: Set<string> }>();

export const readExpandedToolsCache = (messageId: string, expandAll = false): Set<string> => {
  const cached = expandedToolsStateCache.get(messageId);
  return cached && cached.expandAll === expandAll ? new Set(cached.ids) : new Set();
};

export const writeExpandedToolsCache = (
  messageId: string,
  value: Set<string>,
  expandAll = false,
): void => {
  if (
    expandedToolsStateCache.size >= EXPANDED_TOOLS_CACHE_MAX &&
    !expandedToolsStateCache.has(messageId)
  ) {
    const oldest = expandedToolsStateCache.keys().next().value;
    if (typeof oldest === 'string') {
      expandedToolsStateCache.delete(oldest);
    }
  }
  expandedToolsStateCache.set(messageId, { expandAll, ids: new Set(value) });
};
