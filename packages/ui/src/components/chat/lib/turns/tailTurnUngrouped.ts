import type { ChatMessageEntry } from './types';

/**
 * Ungrouped rows (extension entries, notices) that come after the head of the
 * last turn in message order. The last turn renders as the live tail below all
 * static history, so these rows belong below it: left in the static list they
 * would render above the turn they happened inside of, for example a supervisor
 * reply entry appended while the turn that answers the request is still running.
 */
export const collectUngroupedAfterTailTurn = (
    messages: readonly ChatMessageEntry[],
    ungroupedMessageIds: ReadonlySet<string>,
    tailTurnHeadId: string | undefined,
): ReadonlySet<string> => {
    const none: ReadonlySet<string> = new Set();
    if (!tailTurnHeadId || ungroupedMessageIds.size === 0) return none;

    let afterHead = false;
    let ids: Set<string> | undefined;
    for (const message of messages) {
        const id = message.info.id;
        if (id === tailTurnHeadId) {
            afterHead = true;
            continue;
        }
        if (afterHead && ungroupedMessageIds.has(id)) {
            ids ??= new Set<string>();
            ids.add(id);
        }
    }
    return ids ?? none;
};
