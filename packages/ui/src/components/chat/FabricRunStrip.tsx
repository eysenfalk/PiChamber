import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import {
    areActiveFabricRunsEqual,
    selectActiveFabricRuns,
    type ActiveFabricRun,
} from './fabricRunSelectors';
import { formatToolDuration } from './message/parts/toolRenderUtils';

const RunPill: React.FC<{ run: ActiveFabricRun }> = ({ run }) => {
    const now = useDurationTickerNow(run.startedAt !== undefined, 250);
    const detail = run.progress || run.phase;
    return (
        <div
            className="flex min-w-0 items-center gap-2 overflow-hidden rounded-full border border-border/40 bg-card px-3 py-1.5 shadow-sm"
            data-testid="fabric-run-strip-item"
        >
            <Icon name="loader-4" className="size-3.5 shrink-0 text-muted-foreground motion-safe:animate-spin" aria-hidden />
            <span className="typography-micro shrink-0 font-medium text-foreground">Fabric</span>
            <span className="typography-micro min-w-0 flex-1 truncate text-muted-foreground">
                {[
                    run.name,
                    run.total > 0 ? `${run.done}/${run.total} calls` : 'starting',
                    detail,
                ].filter(Boolean).join(' · ')}
            </span>
            {run.startedAt !== undefined ? (
                <span className="typography-micro shrink-0 tabular-nums text-muted-foreground/80">
                    {formatToolDuration(run.startedAt, undefined, now)}
                </span>
            ) : null}
        </div>
    );
};

/** Live status of running fabric runs, above the composer, like Pi's widget. */
export const FabricRunStrip: React.FC<{ sessionId?: string | null }> = ({ sessionId }) => {
    const selectedSessionId = usePiSessionSnapshot((state) => state.selectedSessionId);
    const activeSessionId = sessionId ?? selectedSessionId;

    const runs = usePiSessionSnapshot(
        (state) => selectActiveFabricRuns(activeSessionId ? state.reducer.bySession.get(activeSessionId) : undefined),
        areActiveFabricRunsEqual,
        `session:${activeSessionId ?? ''}`,
    );

    if (runs.length === 0) return null;

    return (
        <div className="chat-input-column" role="status" aria-label="Running Fabric calls">
            <div className="flex flex-col gap-1">
                {runs.map((run) => <RunPill key={run.id} run={run} />)}
            </div>
        </div>
    );
};
