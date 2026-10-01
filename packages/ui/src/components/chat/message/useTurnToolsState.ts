import React from 'react';
import type { Part } from '@/lib/chat/types';
import { useUIStore } from '@/stores/useUIStore';
import type { TurnActivityRecord } from '../lib/turns/types';
import type { ToolPopupContent } from './types';
import {
  readExpandedToolsCache,
  writeExpandedToolsCache,
} from './chatToolExpansion';
import { resolveOpenToolIds, useToolCallsExpanded } from './toolCallsExpansion';

type ToolActivity = TurnActivityRecord & { kind: 'tool'; part: Part & { type: 'tool' } };

const readTurnToolCache = (activities: ToolActivity[], expandAll: boolean): Set<string> => {
  const expanded = new Set<string>();
  const toolIdsByMessage = new Map<string, Set<string>>();

  for (const activity of activities) {
    const ids = toolIdsByMessage.get(activity.messageId) ?? new Set<string>();
    ids.add(activity.id);
    toolIdsByMessage.set(activity.messageId, ids);
  }

  for (const [messageId, toolIds] of toolIdsByMessage) {
    const cachedExpanded = readExpandedToolsCache(messageId, expandAll);
    for (const toolId of toolIds) {
      if (cachedExpanded.has(toolId)) expanded.add(toolId);
    }
  }

  return expanded;
};

const updateOwnerCache = ({
  messageId,
  ownerToolIds,
  nextValue,
  expandAll,
}: {
  messageId: string;
  ownerToolIds: Set<string>;
  nextValue: Set<string>;
  expandAll: boolean;
}): void => {
  // Preserve cached state for tools outside this turn. A message can be
  // revisited from more than one projection, so replacing its whole cache with
  // the turn-local set would silently forget an unrelated tool.
  const cached = readExpandedToolsCache(messageId, expandAll);
  for (const toolId of ownerToolIds) {
    if (nextValue.has(toolId)) {
      cached.add(toolId);
    } else {
      cached.delete(toolId);
    }
  }
  writeExpandedToolsCache(messageId, cached, expandAll);
};

/**
 * Tool disclosure follows the user, never the tool kind: bash/edit tools do
 * not auto-open. The stored set holds the tools the user flipped away from the
 * current default (closed by default, or open while "expand all" is on), and
 * is preserved per message so remounting keeps it. Changing the default
 * starts every turn from a clean slate.
 */
export function useTurnToolsState({
  activities,
}: {
  activities: TurnActivityRecord[];
}) {
  const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);
  const toolActivities = React.useMemo<ToolActivity[]>(() => {
    return activities.filter(
      (activity): activity is ToolActivity => activity.kind === 'tool' && activity.part.type === 'tool',
    );
  }, [activities]);

  const ownerByToolId = React.useMemo(() => {
    const owners = new Map<string, string>();
    for (const activity of toolActivities) {
      owners.set(activity.id, activity.messageId);
    }
    return owners;
  }, [toolActivities]);

  const toolIdsByOwner = React.useMemo(() => {
    const owners = new Map<string, Set<string>>();
    for (const activity of toolActivities) {
      const ids = owners.get(activity.messageId) ?? new Set<string>();
      ids.add(activity.id);
      owners.set(activity.messageId, ids);
    }
    return owners;
  }, [toolActivities]);

  const expandAll = useToolCallsExpanded();
  const [flippedState, setFlippedState] = React.useState(() => ({
    expandAll,
    ids: readTurnToolCache(toolActivities, expandAll),
  }));
  // Derive-state-from-props: when the default flips, re-read the flipped set
  // for the new default in this same render instead of showing one stale frame.
  let flipped = flippedState.ids;
  if (flippedState.expandAll !== expandAll) {
    flipped = readTurnToolCache(toolActivities, expandAll);
    setFlippedState({ expandAll, ids: flipped });
  }
  const [popupContent, setPopupContent] = React.useState<ToolPopupContent>({
    open: false,
    title: '',
    content: '',
  });

  const effectiveExpandedTools = React.useMemo(
    () => resolveOpenToolIds(ownerByToolId.keys(), flipped, expandAll),
    [expandAll, flipped, ownerByToolId],
  );

  const toggleStateRef = React.useRef({
    ownerByToolId,
    toolIdsByOwner,
    expandAll,
  });
  toggleStateRef.current = {
    ownerByToolId,
    toolIdsByOwner,
    expandAll,
  };

  const handleToggleTool = React.useCallback(
    (toolId: string) => {
      const current = toggleStateRef.current;
      const ownerId = current.ownerByToolId.get(toolId);
      if (!ownerId) return;

      const ownerToolIds = current.toolIdsByOwner.get(ownerId) ?? new Set<string>();

      setFlippedState((previous) => {
        // A toggle racing a default change would write into the wrong mode.
        if (previous.expandAll !== current.expandAll) return previous;
        const next = new Set(previous.ids);
        if (next.has(toolId)) {
          next.delete(toolId);
        } else {
          next.add(toolId);
        }
        updateOwnerCache({
          messageId: ownerId,
          ownerToolIds,
          nextValue: next,
          expandAll: current.expandAll,
        });
        return { expandAll: previous.expandAll, ids: next };
      });
    }, [],
  );

  const handleShowPopup = React.useCallback(
    (content: ToolPopupContent) => {
      if (content.image || content.mermaid) {
        setPopupContent(content);
        setImagePreviewOpen(true);
      }
    },
    [setImagePreviewOpen],
  );

  const handlePopupChange = React.useCallback(
    (open: boolean) => {
      setPopupContent((previous) => ({ ...previous, open }));
      setImagePreviewOpen(open);
    },
    [setImagePreviewOpen],
  );

  return {
    effectiveExpandedTools,
    popupContent,
    handleToggleTool,
    handleShowPopup,
    handlePopupChange,
  };
}
