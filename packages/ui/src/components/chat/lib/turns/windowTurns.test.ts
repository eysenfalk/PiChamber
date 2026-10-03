import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@/lib/chat/types';
import { buildTurnWindowModel, updateTurnWindowModelIncremental } from './windowTurns';
import type { ChatMessageEntry } from './types';

function message({ id, role, parentID }: { id: string; role: 'user' | 'assistant' | 'system'; parentID?: string }): ChatMessageEntry {
    return {
        info: {
            id,
            role,
            ...(parentID ? { parentID } : {}),
            time: { created: 1 },
        } as Message,
        parts: [] as Part[],
    };
}

describe('windowTurns', () => {
    test('does not map assistant messages without a parent to the current turn', () => {
        const user = message({ id: 'u1', role: 'user' });
        const assistant = message({ id: 'a1', role: 'assistant' });

        const model = buildTurnWindowModel([user, assistant]);

        expect(model.messageToTurnId.get('u1')).toBe('u1');
        expect(model.messageToTurnId.has('a1')).toBe(false);
    });

    test('incremental update does not map assistant messages without a parent to the current turn', () => {
        const user = message({ id: 'u1', role: 'user' });
        const assistant = message({ id: 'a1', role: 'assistant' });
        const base = buildTurnWindowModel([user]);

        const next = updateTurnWindowModelIncremental(base, [user], [user, assistant]);

        expect(next?.messageToTurnId.get('u1')).toBe('u1');
        expect(next?.messageToTurnId.has('a1')).toBe(false);
    });

    test('maps assistant messages to their parent user turn', () => {
        const user = message({ id: 'u1', role: 'user' });
        const assistant = message({ id: 'a1', role: 'assistant', parentID: 'u1' });

        const model = buildTurnWindowModel([user, assistant]);

        expect(model.messageToTurnId.get('a1')).toBe('u1');
    });
});

describe('windowTurns with an extension message turn head', () => {
    const extension = (id: string): ChatMessageEntry => ({
        info: { id, role: 'extension', time: { created: 1 } } as unknown as Message,
        parts: [] as Part[],
    });

    test('an extension message named as parent by an assistant is a turn head', () => {
        const user = message({ id: 'u1', role: 'user' });
        const request = extension('ext1');
        const assistant = message({ id: 'a1', role: 'assistant', parentID: 'ext1' });

        const model = buildTurnWindowModel([user, request, assistant]);

        expect(model.turnIds).toEqual(['u1', 'ext1']);
        expect(model.turnMessageStartIndexes).toEqual([0, 1]);
        expect(model.messageToTurnId.get('a1')).toBe('ext1');
        expect(model.messageToTurnId.get('ext1')).toBe('ext1');
    });

    test('an extension message nobody names stays part of the current turn window', () => {
        const user = message({ id: 'u1', role: 'user' });
        const note = extension('ext1');

        const model = buildTurnWindowModel([user, note]);

        expect(model.turnIds).toEqual(['u1']);
        expect(model.messageToTurnId.get('ext1')).toBe('u1');
    });

    test('the incremental update agrees with a full rebuild when the triggered reply arrives', () => {
        const user = message({ id: 'u1', role: 'user' });
        const request = extension('ext1');
        const assistant = message({ id: 'a1', role: 'assistant', parentID: 'ext1' });
        const base = buildTurnWindowModel([user, request]);

        const next = updateTurnWindowModelIncremental(base, [user, request], [user, request, assistant]);
        const model = next ?? buildTurnWindowModel([user, request, assistant]);

        expect(model.turnIds).toEqual(['u1', 'ext1']);
        expect(model.messageToTurnId.get('a1')).toBe('ext1');
    });
});
