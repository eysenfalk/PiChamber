import { useUIStore } from '@/stores/useUIStore';

/**
 * "Open every tool call" as it applies right now. The window toggle wins over
 * the saved preference; with no toggle in play the saved preference decides.
 */
export const useToolCallsExpanded = (): boolean => useUIStore(
  (state) => state.toolCallsExpandedOverride ?? state.expandToolCallsByDefault,
);

export const toggleToolCallsExpanded = (): void => {
  const { toolCallsExpandedOverride, expandToolCallsByDefault, setToolCallsExpandedOverride } = useUIStore.getState();
  setToolCallsExpandedOverride(!(toolCallsExpandedOverride ?? expandToolCallsByDefault));
};

/**
 * Which tools render open. `flipped` holds the ones the user moved away from
 * the default: with "expand all" off they are the open ones, with it on they
 * are the closed ones.
 */
export const resolveOpenToolIds = (
  toolIds: Iterable<string>,
  flipped: ReadonlySet<string>,
  expandAll: boolean,
): Set<string> => {
  if (!expandAll) return new Set(flipped);
  const open = new Set<string>();
  for (const id of toolIds) {
    if (!flipped.has(id)) open.add(id);
  }
  return open;
};
