import { describe, expect, test } from 'bun:test';

import type { Message, Part } from '@/lib/chat/types';
import { projectTurnRecords } from './projectTurnRecords';
import { collectUngroupedAfterTailTurn } from './tailTurnUngrouped';
import type { ChatMessageEntry } from './types';

const entry = (id: string, role: string, extra: Record<string, unknown> = {}): ChatMessageEntry => ({
    info: { id, role, time: { created: 1 }, ...extra } as unknown as Message,
    parts: [] as Part[],
});

describe('collectUngroupedAfterTailTurn', () => {
    // user prompt, its reply, a supervisor request that heads the last turn, the
    // reply entry appended inside that turn, and the assistant message after it.
    const messages = [
        entry('u1', 'user'),
        entry('a1', 'assistant', { parentID: 'u1' }),
        entry('req', 'extension'),
        entry('a2', 'assistant', { parentID: 'req' }),
        entry('reply', 'extension'),
        entry('a3', 'assistant', { parentID: 'req' }),
    ];

    test('returns the ungrouped rows that follow the head of the last turn', () => {
        const projection = projectTurnRecords(messages);
        const lastTurn = projection.turns[projection.turns.length - 1];

        expect(lastTurn?.turnId).toBe('req');
        expect([...collectUngroupedAfterTailTurn(messages, projection.ungroupedMessageIds, lastTurn?.userMessage.info.id)]).toEqual(['reply']);
    });

    test('keeps rows before the head of the last turn in the static history', () => {
        const withEarlierNote = [entry('note', 'extension'), ...messages];
        const projection = projectTurnRecords(withEarlierNote);

        expect(projection.ungroupedMessageIds.has('note')).toBe(true);
        expect(collectUngroupedAfterTailTurn(withEarlierNote, projection.ungroupedMessageIds, 'req').has('note')).toBe(false);
    });

    test('returns nothing without a tail turn or ungrouped rows', () => {
        expect(collectUngroupedAfterTailTurn(messages, new Set(['reply']), undefined).size).toBe(0);
        expect(collectUngroupedAfterTailTurn(messages, new Set(), 'req').size).toBe(0);
    });
});
