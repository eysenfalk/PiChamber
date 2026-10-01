import { describe, expect, test } from 'bun:test';

import {
    COMPACT_CALL_LIMIT,
    EXPANDED_CALL_LIMIT,
    PREVIEW_LINE_LIMIT,
    countNestedCalls,
    findPreviewCallIndex,
    lightenNestedCalls,
    readNestedToolCalls,
    readPreviewLines,
    readRunProgress,
    selectVisibleCallIndexes,
    type NestedToolCall,
} from './nestedToolCalls';

const done = (name: string, extra: Partial<NestedToolCall> = {}): NestedToolCall => ({ name, success: true, ...extra });
const running = (name: string): NestedToolCall => ({ name });

describe('readNestedToolCalls', () => {
    test('returns nothing without a nestedCalls list', () => {
        expect(readNestedToolCalls(undefined)).toEqual([]);
        expect(readNestedToolCalls({ nestedCalls: 'nope' })).toEqual([]);
    });

    test('keeps well formed calls and drops malformed entries', () => {
        const calls = readNestedToolCalls({
            nestedCalls: [
                { name: 'edit', input: { path: '/a' }, success: true, output: 'ok', metadata: { diff: 'd' }, startedAt: 1, endedAt: 2 },
                { name: '' },
                'string',
                { name: 'read', input: 'not a record', startedAt: Number.NaN },
            ],
        });
        expect(calls).toEqual([
            { name: 'edit', input: { path: '/a' }, success: true, output: 'ok', metadata: { diff: 'd' }, startedAt: 1, endedAt: 2 },
            { name: 'read' },
        ]);
    });
});

describe('readRunProgress', () => {
    test('reads the progress line and phase names', () => {
        expect(readRunProgress({ progress: ' Phase: build ', phases: ['plan', 3, '', 'build'] })).toEqual({
            progress: 'Phase: build',
            phases: ['plan', 'build'],
        });
        expect(readRunProgress(undefined)).toEqual({ progress: '', phases: [] });
    });
});

describe('countNestedCalls', () => {
    test('counts running and failed calls; unreported calls run only while the parent runs', () => {
        const calls = [done('a'), { name: 'b', success: false }, running('c')];
        expect(countNestedCalls(calls, false)).toEqual({ total: 3, done: 2, running: 1, failed: 1 });
        expect(countNestedCalls(calls, true)).toEqual({ total: 3, done: 3, running: 0, failed: 1 });
    });
});

describe('selectVisibleCallIndexes', () => {
    const many = (count: number, runningAt: number[] = []) => Array.from({ length: count }, (_, index) => (
        runningAt.includes(index) ? running(`c${index}`) : done(`c${index}`)
    ));

    test('shows everything up to the compact limit', () => {
        const { indexes, hidden } = selectVisibleCallIndexes(many(COMPACT_CALL_LIMIT), false, true);
        expect(indexes).toHaveLength(COMPACT_CALL_LIMIT);
        expect(hidden).toBe(0);
    });

    test('past the limit, running calls take slots first and the earliest fill the rest', () => {
        const { indexes, hidden } = selectVisibleCallIndexes(many(12, [10, 11]), false, false);
        expect(indexes).toEqual([0, 1, 2, 3, 4, 5, 10, 11]);
        expect(hidden).toBe(4);
    });

    test('more running calls than slots keeps the latest ones', () => {
        const calls = many(20, Array.from({ length: 12 }, (_, i) => i + 5));
        const { indexes } = selectVisibleCallIndexes(calls, false, false);
        expect(indexes).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
        expect(indexes).toHaveLength(COMPACT_CALL_LIMIT);
        expect(indexes.every((index) => index >= 9)).toBe(true);
    });

    test('expanded shows up to the expanded limit and reports the rest', () => {
        const { indexes, hidden } = selectVisibleCallIndexes(many(40), true, true);
        expect(indexes).toHaveLength(EXPANDED_CALL_LIMIT);
        expect(hidden).toBe(10);
    });
});

describe('previews', () => {
    const diff = Array.from({ length: 15 }, (_, i) => `+${i + 1} line ${i + 1}`).join('\n');

    test('an edit previews the head of its diff, colored by prefix', () => {
        const lines = readPreviewLines(done('edit', { metadata: { diff: `-1 old\n+1 new\n 2 same\n${diff}` } }));
        expect(lines).toHaveLength(PREVIEW_LINE_LIMIT);
        expect(lines.slice(0, 3).map((line) => line.kind)).toEqual(['remove', 'add', 'context']);
    });

    test('a write previews the head of its content as added lines', () => {
        expect(readPreviewLines(done('write', { input: { content: 'a\nb\n' } }))).toEqual([
            { text: '+a', kind: 'add' },
            { text: '+b', kind: 'add' },
        ]);
    });

    test('failed or running calls preview nothing', () => {
        expect(readPreviewLines({ name: 'edit', success: false, metadata: { diff: '+1 x' } })).toEqual([]);
        expect(readPreviewLines({ name: 'edit', metadata: { diff: '+1 x' } })).toEqual([]);
    });

    test('the preview belongs to the last successful edit or write', () => {
        const calls = [
            done('edit', { metadata: { diff: '+1 a' } }),
            done('write', { input: { content: 'x' } }),
            done('read'),
            done('edit', { success: false, metadata: { diff: '+1 b' } } as Partial<NestedToolCall>),
        ];
        expect(findPreviewCallIndex(calls)).toBe(1);
        expect(findPreviewCallIndex([done('read')])).toBe(-1);
    });
});

describe('lightenNestedCalls', () => {
    const big = 'x'.repeat(5000);

    test('drops outputs and long input, keeps outcome, timing and change counts', () => {
        const [light] = lightenNestedCalls([
            done('read', { input: { path: '/a', blob: big, offset: 3 }, output: big, startedAt: 1, endedAt: 4 }),
        ]);
        expect(light).toEqual({ name: 'read', input: { path: '/a', offset: 3 }, success: true, startedAt: 1, endedAt: 4 });
    });

    test('keeps a bounded diff head only on the preview call', () => {
        const diff = Array.from({ length: 40 }, (_, i) => `+${i + 1} ${big}`).join('\n');
        const light = lightenNestedCalls([
            done('edit', { metadata: { diff: '+1 old', additions: 1, deletions: 0 } }),
            done('edit', { metadata: { diff, additions: 40, deletions: 0 } }),
        ]);
        expect(light[0].metadata?.diff).toBeUndefined();
        expect(light[0].metadata?.additions).toBe(1);
        expect((light[1].metadata?.diff as string).length <= 1200).toBe(true);
        expect(readPreviewLines(light[1]).length).toBeGreaterThan(0);
    });

    test('a write keeps a bounded content head so it still previews', () => {
        const [light] = lightenNestedCalls([done('write', { input: { path: '/a', content: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') } })]);
        const lines = readPreviewLines(light);
        expect(lines).toHaveLength(PREVIEW_LINE_LIMIT);
        expect(lines[0].text).toBe('+line 0');
    });

    test('a running call stays running', () => {
        expect(lightenNestedCalls([running('bash')])[0].success).toBeUndefined();
    });
});
