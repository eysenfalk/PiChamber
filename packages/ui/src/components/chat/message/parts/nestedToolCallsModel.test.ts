import { describe, expect, test } from 'bun:test';

import { buildNestedToolParts } from './nestedToolCallsModel';

describe('buildNestedToolParts', () => {
    const calls = [
        { name: 'edit', input: { path: '/a' }, success: true, output: 'ok', metadata: { diff: 'd' }, startedAt: 1, endedAt: 2 },
        { name: 'bash', success: false, error: 'exit 1' },
        { name: 'grep' },
    ];

    test('maps calls to indexed tool parts that carry input, output, metadata, and time', () => {
        const parts = buildNestedToolParts('parent', calls, true);
        expect(parts.map((part) => [part.id, part.tool])).toEqual([
            ['parent:nested:0', 'edit'],
            ['parent:nested:1', 'bash'],
            ['parent:nested:2', 'grep'],
        ]);
        expect(parts[0].state).toEqual({
            status: 'completed',
            input: { path: '/a' },
            output: 'ok',
            metadata: { diff: 'd' },
            time: { start: 1, end: 2 },
        });
        expect(parts[1].state).toMatchObject({ status: 'error', error: 'exit 1' });
    });

    test('a call without an outcome runs only while the outer call runs', () => {
        expect(buildNestedToolParts('p', calls, false)[2].state?.status).toBe('running');
        expect(buildNestedToolParts('p', calls, true)[2].state?.status).toBe('completed');
    });
});
