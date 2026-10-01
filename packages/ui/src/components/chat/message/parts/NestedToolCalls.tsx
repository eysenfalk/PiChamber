import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { ToolPart as ToolPartType } from '@/lib/chat/types';
import {
    countNestedCalls,
    findPreviewCallIndex,
    readPreviewLines,
    selectVisibleCallIndexes,
    type NestedToolCall,
} from '@/lib/chat/nestedToolCalls';
import { buildNestedToolParts } from './nestedToolCallsModel';
import { resolveOpenToolIds, useToolCallsExpanded } from '../toolCallsExpansion';

interface NestedToolCallsProps {
    parentId: string;
    calls: NestedToolCall[];
    parentSettled: boolean;
    /** The outer call is still running. */
    isActive: boolean;
    /** The card is open: more rows, plus the raw code and result. */
    isExpanded: boolean;
    onToggleCard: () => void;
    /** Optional one line summary of what the run does. */
    description?: string;
    /** The run's own progress line, streamed while it runs. */
    progress?: string;
    phases?: string[];
    /** The parent call's own input and result, shown only while expanded. */
    rawDetails?: React.ReactNode;
    /** Supplied by `ToolPart` so this file does not import it back. */
    renderRow: (part: ToolPartType, isExpanded: boolean, onToggle: (toolId: string) => void) => React.ReactNode;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

const formatCallCount = (count: number): string => (count === 1 ? '1 call' : `${count} calls`);

const PREVIEW_COLORS = {
    add: 'var(--status-success)',
    remove: 'var(--status-error)',
    context: 'var(--tools-description)',
} as const;

const DiffPreview: React.FC<{ call: NestedToolCall }> = ({ call }) => {
    const lines = readPreviewLines(call);
    if (lines.length === 0) {
        return null;
    }
    return (
        <pre
            className="typography-code mb-1 ml-5 overflow-hidden text-xs leading-snug"
            aria-label="Latest change"
            data-testid="fabric-run-preview"
        >
            {lines.map((line, index) => (
                <div key={index} className="truncate" style={{ color: PREVIEW_COLORS[line.kind] }}>
                    {line.text}
                </div>
            ))}
        </pre>
    );
};

interface RunSummaryProps {
    active: boolean;
    total: number;
    done: number;
    failed: number;
    progress?: string;
    phase?: string;
}

/** The one line over the rows: running count and progress, or the settled total. */
const RunSummary: React.FC<RunSummaryProps> = ({ active, total, done, failed, progress, phase }) => {
    const hasFailures = failed > 0;
    const detail = progress || phase;
    return (
        <div className="typography-meta mb-0.5 flex min-w-0 items-center gap-1.5 text-muted-foreground" data-testid="fabric-run-summary">
            {active ? (
                <Icon name="loader-4" className="size-3 shrink-0 motion-safe:animate-spin" aria-hidden />
            ) : hasFailures ? (
                <Icon name="error-warning" className="size-3 shrink-0" style={{ color: 'var(--status-error)' }} aria-hidden />
            ) : (
                <Icon name="check" className="size-3 shrink-0" aria-hidden />
            )}
            <span className="min-w-0 truncate">
                {total === 0
                    ? 'Running…'
                    : active
                        ? `Tools running · ${done}/${total} calls`
                        : `Tools · ${formatCallCount(total)}`}
                {hasFailures ? <span style={{ color: 'var(--status-error)' }}>{` · ${failed} failed`}</span> : null}
                {active && detail ? ` · ${detail}` : null}
            </span>
        </div>
    );
};

/**
 * Calls that ran inside one tool call, drawn the way pi-fabric draws them in
 * the Pi TUI: compact and visible without a click, with the live running
 * state, and a single expand for more.
 */
export const NestedToolCalls: React.FC<NestedToolCallsProps> = ({
    parentId,
    calls,
    parentSettled,
    isActive,
    isExpanded,
    onToggleCard,
    description,
    progress,
    phases,
    rawDetails,
    renderRow,
}) => {
    const expandAll = useToolCallsExpanded();
    // Rows the user flipped away from the current default. A default change
    // starts over, because a flip means the opposite in the other mode.
    const [flippedState, setFlippedState] = React.useState<{ expandAll: boolean; ids: ReadonlySet<string> }>(
        () => ({ expandAll, ids: new Set() }),
    );
    const flipped = flippedState.expandAll === expandAll ? flippedState.ids : EMPTY_IDS;
    const [rawOpen, setRawOpen] = React.useState(false);
    const parts = React.useMemo(
        () => buildNestedToolParts(parentId, calls, parentSettled),
        [calls, parentId, parentSettled],
    );
    const openRowIds = React.useMemo(
        () => resolveOpenToolIds(parts.map((part) => part.id), flipped, expandAll),
        [expandAll, flipped, parts],
    );
    const onRowToggle = React.useCallback((toolId: string) => {
        setFlippedState((current) => {
            const base = current.expandAll === expandAll ? current.ids : EMPTY_IDS;
            const next = new Set(base);
            if (!next.delete(toolId)) {
                next.add(toolId);
            }
            return { expandAll, ids: next };
        });
    }, [expandAll]);
    // A compact card has no per row bodies, so a click on a row opens the card.
    const handleRowToggle = isExpanded ? onRowToggle : onToggleCard;

    const counts = React.useMemo(() => countNestedCalls(calls, parentSettled), [calls, parentSettled]);
    const { indexes, hidden } = React.useMemo(
        () => selectVisibleCallIndexes(calls, isExpanded, parentSettled),
        [calls, isExpanded, parentSettled],
    );
    const previewIndex = React.useMemo(() => findPreviewCallIndex(calls), [calls]);
    const lastPhase = phases && phases.length > 0 ? phases[phases.length - 1] : undefined;

    return (
        <div className="relative ml-2 pb-1 pl-3" data-chat-tool-indent="true">
            <span
                aria-hidden="true"
                className="pointer-events-none absolute left-0 top-px bottom-0 w-px"
                style={{ backgroundColor: 'var(--tools-border)' }}
            />
            {description ? (
                <p className="typography-meta mb-1 text-muted-foreground">{description}</p>
            ) : null}
            <RunSummary
                active={isActive}
                total={counts.total}
                done={counts.done}
                failed={counts.failed}
                progress={progress}
                phase={lastPhase}
            />
            {calls.length > 0 ? (
                <div role="group" aria-label="Nested tool calls">
                    {indexes.map((index) => {
                        const part = parts[index];
                        const rowOpen = isExpanded && openRowIds.has(part.id);
                        return (
                            <React.Fragment key={part.id}>
                                {renderRow(part, rowOpen, handleRowToggle)}
                                {index === previewIndex && !rowOpen ? <DiffPreview call={calls[index]} /> : null}
                            </React.Fragment>
                        );
                    })}
                </div>
            ) : null}
            {hidden > 0 ? (
                isExpanded ? (
                    <div className="typography-meta text-muted-foreground/80">
                        {`… ${hidden} more nested calls not shown`}
                    </div>
                ) : (
                    <button
                        type="button"
                        className="typography-meta text-muted-foreground/80 hover:text-foreground"
                        onClick={onToggleCard}
                    >
                        {`… ${hidden} nested ${hidden === 1 ? 'call' : 'calls'} hidden · expand`}
                    </button>
                )
            ) : null}
            {isExpanded && rawDetails ? (
                <div className="mt-1">
                    <button
                        type="button"
                        className="typography-meta text-muted-foreground/80 hover:text-foreground"
                        aria-expanded={rawOpen}
                        onClick={() => setRawOpen((open) => !open)}
                    >
                        {rawOpen ? 'Hide code and result' : 'Show code and result'}
                    </button>
                    {rawOpen ? rawDetails : null}
                </div>
            ) : null}
        </div>
    );
};
