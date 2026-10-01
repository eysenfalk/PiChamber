import { describe, expect, test } from 'bun:test';

import type { PiReducerSessionState } from '@/lib/pi/event-reducer';
import { areActiveFabricRunsEqual, selectActiveFabricRuns } from './fabricRunSelectors';

type ToolState = 'pending' | 'running' | 'completed' | 'error' | 'cancelled';

const session = (lifecycle: string, parts: Array<{ id: string; messageId: string; callId: string; name: string; state: ToolState; input?: unknown; metadata?: Record<string, unknown>; startedAt?: number }>) => {
    const partMap = new Map<string, unknown>();
    const partOrder = new Map<string, string[]>();
    const toolsByCallId = new Map<string, string>();
    for (const part of parts) {
        partMap.set(part.id, {
            id: part.id,
            type: 'tool',
            text: '',
            streaming: false,
            index: 0,
            tool: { toolCallId: part.callId, name: part.name, state: part.state, input: part.input, metadata: part.metadata, startedAt: part.startedAt },
        });
        partOrder.set(part.messageId, [...(partOrder.get(part.messageId) ?? []), part.id]);
        if (part.state === 'running' || part.state === 'pending') toolsByCallId.set(part.callId, part.messageId);
    }
    return { parts: partMap, partOrder, toolsByCallId, lifecycle } as unknown as PiReducerSessionState;
};

describe('selectActiveFabricRuns', () => {
    test('returns nothing without a session or without running tools', () => {
        expect(selectActiveFabricRuns(undefined)).toEqual([]);
        expect(selectActiveFabricRuns(session('busy', []))).toEqual([]);
    });

    test('reports a running fabric run with counts, progress, phase and start', () => {
        const runs = selectActiveFabricRuns(session('busy', [{
            id: 'p1',
            messageId: 'm1',
            callId: 'c1',
            name: 'fabric_exec',
            state: 'running',
            input: { display: { name: 'Refactor', description: 'd' } },
            metadata: {
                nestedCalls: [{ name: 'read', success: true }, { name: 'edit', success: true }, { name: 'bash' }],
                progress: 'Calling pi.bash',
                phases: ['plan', 'build'],
            },
            startedAt: 5,
        }]));
        expect(runs).toEqual([{ id: 'p1', name: 'Refactor', total: 3, done: 2, progress: 'Calling pi.bash', phase: 'build', startedAt: 5 }]);
    });

    test('ignores other tools and settled fabric runs', () => {
        expect(selectActiveFabricRuns(session('busy', [
            { id: 'a', messageId: 'm1', callId: 'c1', name: 'bash', state: 'running' },
            { id: 'b', messageId: 'm1', callId: 'c2', name: 'fabric_exec', state: 'completed' },
        ]))).toEqual([]);
    });

    test('a run with no nested calls yet still shows, with a zero count', () => {
        const [run] = selectActiveFabricRuns(session('busy', [{ id: 'p', messageId: 'm', callId: 'c', name: 'fabric_exec', state: 'running' }]));
        expect(run).toMatchObject({ total: 0, done: 0, name: '' });
    });

    test('shows nothing once the session is no longer running, even if a tool never ended', () => {
        const stuck = [{ id: 'p', messageId: 'm', callId: 'c', name: 'fabric_exec', state: 'running' as const }];
        for (const lifecycle of ['idle', 'error', 'interrupted']) {
            expect(selectActiveFabricRuns(session(lifecycle, stuck))).toEqual([]);
        }
        expect(selectActiveFabricRuns(session('retry', stuck))).toHaveLength(1);
    });

    test('shows at most three runs', () => {
        const parts = Array.from({ length: 5 }, (_, index) => ({
            id: `p${index}`, messageId: 'm', callId: `c${index}`, name: 'fabric_exec', state: 'running' as const,
        }));
        expect(selectActiveFabricRuns(session('busy', parts))).toHaveLength(3);
    });
});

describe('areActiveFabricRunsEqual', () => {
    const run = { id: 'p', name: 'n', total: 1, done: 0, progress: '', phase: '', startedAt: 1 };
    test('equal by value, different when a shown field changes', () => {
        expect(areActiveFabricRunsEqual([run], [{ ...run }])).toBe(true);
        expect(areActiveFabricRunsEqual([run], [{ ...run, done: 1 }])).toBe(false);
        expect(areActiveFabricRunsEqual([run], [])).toBe(false);
    });
});
