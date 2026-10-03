import type { ChatMessageEntry } from './types';

const NO_TURN_HEADS: ReadonlySet<string> = new Set();

const roleOf = (message: ChatMessageEntry): string => {
    const role = (message.info as { clientRole?: string | null; role?: string | null }).clientRole ?? message.info.role;
    return typeof role === 'string' ? role : '';
};

/**
 * Ids of extension messages that head a turn: an assistant message names one as
 * its parent. Pi starts such a turn from a displayed extension message
 * (`pi.sendMessage` with `triggerTurn`, e.g. a subagent supervisor request), so
 * the turn renders at that message instead of under the previous user prompt.
 * Extension messages no assistant names stay ungrouped rows.
 */
export const collectExtensionTurnHeadIds = (messages: ChatMessageEntry[]): ReadonlySet<string> => {
    const extensionIds = new Set<string>();
    for (const message of messages) {
        if (roleOf(message) === 'extension') extensionIds.add(message.info.id);
    }
    if (extensionIds.size === 0) return NO_TURN_HEADS;

    const headIds = new Set<string>();
    for (const message of messages) {
        if (roleOf(message) !== 'assistant') continue;
        const parentId = (message.info as { parentID?: unknown }).parentID;
        if (typeof parentId === 'string' && extensionIds.has(parentId)) headIds.add(parentId);
    }
    return headIds.size === 0 ? NO_TURN_HEADS : headIds;
};
