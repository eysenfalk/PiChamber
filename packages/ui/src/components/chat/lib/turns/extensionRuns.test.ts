import { describe, expect, test } from 'bun:test';

import type { Message, Part } from '@/lib/chat/types';

import { groupExtensionRuns } from './extensionRuns';
import type { ChatMessageEntry } from './types';

const extension = (id: string, customType: string): ChatMessageEntry => ({
    info: { id, sessionID: 's', role: 'extension', customType, text: id, time: { created: 1 } } as Message,
    parts: [] as Part[],
});

const ungrouped = (message: ChatMessageEntry) => ({ kind: 'ungrouped' as const, key: `msg:${message.info.id}`, message });
const turn = (id: string) => ({ kind: 'turn' as const, key: `turn:${id}` });

describe('groupExtensionRuns', () => {
    test('merges adjacent extension rows of one custom type into one run keyed by its first message', () => {
        const entries = [
            turn('t1'),
            ungrouped(extension('a', 'intercom_message')),
            ungrouped(extension('b', 'intercom_message')),
            ungrouped(extension('c', 'intercom_message')),
            turn('t2'),
        ];
        const grouped = groupExtensionRuns(entries);
        expect(grouped.map((entry) => entry.key)).toEqual(['turn:t1', 'extension-run:a', 'turn:t2']);
        const run = grouped[1];
        expect(run?.kind).toBe('extension-run');
        if (run?.kind !== 'extension-run') throw new Error('expected run');
        expect(run.customType).toBe('intercom_message');
        expect(run.messages.map((message) => message.info.id)).toEqual(['a', 'b', 'c']);
    });

    test('appending to a run keeps its key', () => {
        const two = groupExtensionRuns([ungrouped(extension('a', 'x')), ungrouped(extension('b', 'x'))]);
        const three = groupExtensionRuns([
            ungrouped(extension('a', 'x')),
            ungrouped(extension('b', 'x')),
            ungrouped(extension('c', 'x')),
        ]);
        expect(two[0]?.key).toBe(three[0]?.key);
    });

    test('a different custom type or a turn breaks the run, and a single message stays ungrouped', () => {
        const entries = [
            ungrouped(extension('a', 'subagent-notify')),
            ungrouped(extension('b', 'intercom_message')),
            turn('t1'),
            ungrouped(extension('c', 'intercom_message')),
        ];
        const grouped = groupExtensionRuns(entries);
        expect(grouped).toBe(entries);
    });

    test('unknown custom types group like known ones', () => {
        const grouped = groupExtensionRuns([
            ungrouped(extension('a', 'some-plugin-note')),
            ungrouped(extension('b', 'some-plugin-note')),
        ]);
        expect(grouped).toHaveLength(1);
        expect(grouped[0]?.kind).toBe('extension-run');
    });

    test('GUI descriptor cards and supervisor requests stay standalone', () => {
        const entries = [
            ungrouped(extension('a', 'pichamber.ui')),
            ungrouped(extension('b', 'pichamber.ui')),
            ungrouped(extension('c', 'subagent_supervisor_request')),
            ungrouped(extension('d', 'subagent_supervisor_request')),
        ];
        expect(groupExtensionRuns(entries)).toBe(entries);
    });

    test('non-extension ungrouped rows never group', () => {
        const notice = (id: string) => ({
            info: { id, sessionID: 's', role: 'assistant', time: { created: 1 } } as Message,
            parts: [] as Part[],
        });
        const entries = [ungrouped(notice('a')), ungrouped(notice('b'))];
        expect(groupExtensionRuns(entries)).toBe(entries);
    });
});
