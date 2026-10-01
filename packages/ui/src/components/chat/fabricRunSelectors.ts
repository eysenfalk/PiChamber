import type { PiReducerSessionState } from '@/lib/pi/event-reducer';
import { countNestedCalls, readNestedToolCalls, readRunProgress } from '@/lib/chat/nestedToolCalls';
import { readFabricExecDisplay } from './message/parts/toolRenderUtils';

/** A running `fabric_exec` call, reduced to what the run strip shows. */
export interface ActiveFabricRun {
    id: string;
    name: string;
    total: number;
    done: number;
    progress: string;
    phase: string;
    startedAt: number | undefined;
}

const MAX_STRIP_RUNS = 3;

/**
 * Pi mounts a live widget for running fabric runs, but its lines are pi-tui
 * components that never cross the RPC bridge. The same facts are on the tool
 * calls themselves, so the strip is derived from the running ones of a
 * session that is itself running: live state only, nothing from history.
 */
export const selectActiveFabricRuns = (
    session: PiReducerSessionState | null | undefined,
): ActiveFabricRun[] => {
    if (!session || session.toolsByCallId.size === 0) return [];
    // A tool left 'running' by a lost end event must not outlive its run.
    if (session.lifecycle !== 'busy' && session.lifecycle !== 'retry') return [];
    const runs: ActiveFabricRun[] = [];
    for (const [toolCallId, messageId] of session.toolsByCallId) {
        for (const partId of session.partOrder.get(messageId) ?? []) {
            const part = session.parts.get(partId);
            const tool = part?.type === 'tool' ? part.tool : undefined;
            if (!part || !tool || tool.toolCallId !== toolCallId || tool.name !== 'fabric_exec') continue;
            if (tool.state !== 'running' && tool.state !== 'pending') continue;
            const metadata = tool.metadata;
            const counts = countNestedCalls(readNestedToolCalls(metadata), false);
            const { progress, phases } = readRunProgress(metadata);
            const input = typeof tool.input === 'object' && tool.input !== null
                ? tool.input as Record<string, unknown>
                : undefined;
            runs.push({
                id: part.id,
                name: readFabricExecDisplay(input).name,
                total: counts.total,
                done: counts.done,
                progress,
                phase: phases.length > 0 ? phases[phases.length - 1] : '',
                startedAt: tool.startedAt,
            });
        }
    }
    return runs.slice(0, MAX_STRIP_RUNS);
};

const runKey = (run: ActiveFabricRun): string => (
    [run.id, run.name, run.total, run.done, run.progress, run.phase, run.startedAt ?? ''].join('\u0000')
);

export const areActiveFabricRunsEqual = (a: ActiveFabricRun[], b: ActiveFabricRun[]): boolean => (
    a.length === b.length && a.every((run, index) => runKey(run) === runKey(b[index]))
);
