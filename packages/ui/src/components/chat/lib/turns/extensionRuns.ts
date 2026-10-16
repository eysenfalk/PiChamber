import { PI_EXTENSION_UI_NAMESPACE } from '@/lib/pi/extension-ui';
import { SUPERVISOR_REQUEST_MESSAGE_TYPE } from '@/lib/pi/supervisor-ui';

import type { ChatMessageEntry } from './types';

/** Consecutive ungrouped extension messages of one custom type, shown as one row. */
export type ExtensionRunEntry = {
    kind: 'extension-run';
    key: string;
    customType: string;
    messages: ChatMessageEntry[];
};

type ListEntry = { kind: string; key: string; message?: ChatMessageEntry };

/**
 * Custom type a message groups under, or undefined when it never groups.
 * `pichamber.` UI cards can carry actions and supervisor requests wait for an
 * answer, so both stay standalone; every other extension message (intercom,
 * subagent notices, context plugins, unknown extensions) groups with its
 * same-type neighbours.
 */
const runKindOf = (entry: ListEntry): string | undefined => {
    if (entry.kind !== 'ungrouped' || !entry.message) return undefined;
    const info = entry.message.info as { role?: string; customType?: unknown };
    if (info.role !== 'extension') return undefined;
    const customType = info.customType;
    if (typeof customType !== 'string' || customType.length === 0) return undefined;
    if (customType.startsWith(PI_EXTENSION_UI_NAMESPACE) || customType === SUPERVISOR_REQUEST_MESSAGE_TYPE) {
        return undefined;
    }
    return customType;
};

/**
 * Merges runs of two or more adjacent ungrouped extension rows with the same
 * custom type into one `extension-run` entry, so a burst of intercom or
 * subagent notices takes one row instead of pushing the conversation away.
 * Turns and other rows break a run. The run key follows its first message, so
 * appending to a run keeps its row. Returns the input array when nothing merges.
 */
export const groupExtensionRuns = <E extends ListEntry>(entries: E[]): Array<E | ExtensionRunEntry> => {
    let output: Array<E | ExtensionRunEntry> | undefined;
    let index = 0;
    while (index < entries.length) {
        const entry = entries[index] as E;
        const kind = runKindOf(entry);
        let end = index + 1;
        if (kind !== undefined) {
            while (end < entries.length && runKindOf(entries[end] as E) === kind) end += 1;
        }
        if (kind === undefined || end - index < 2) {
            output?.push(entry);
            index += 1;
            continue;
        }
        output ??= entries.slice(0, index);
        const messages = entries.slice(index, end).map((item) => item.message as ChatMessageEntry);
        output.push({
            kind: 'extension-run',
            key: `extension-run:${messages[0]?.info.id ?? index}`,
            customType: kind,
            messages,
        });
        index = end;
    }
    return output ?? entries;
};
