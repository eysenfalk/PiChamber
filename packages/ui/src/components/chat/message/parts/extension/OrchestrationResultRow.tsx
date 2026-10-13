import * as React from 'react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import type { OrchestrationOutcome, OrchestrationResult } from '@/lib/pi/orchestration-ui';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { MarkdownRenderer } from '../../../MarkdownRenderer';

const outcomeLabels: Record<OrchestrationOutcome, string> = {
    completed: 'finished',
    interrupted: 'interrupted',
    error: 'failed',
};

const outcomeIcons: Record<OrchestrationOutcome, IconName> = {
    completed: 'checkbox-circle',
    interrupted: 'stop',
    error: 'error-warning',
};

const outcomeTones: Record<OrchestrationOutcome, string> = {
    completed: 'text-status-success',
    interrupted: 'text-muted-foreground',
    error: 'text-status-error',
};

/**
 * A worker's result in its orchestrator's transcript: one compact row with the
 * worker, its outcome and the first reply line. Expanding shows the full reply;
 * the open action switches to the worker session, which the owner can talk to.
 */
export const OrchestrationResultRow: React.FC<{
    messageId: string;
    result: OrchestrationResult;
    defaultExpanded?: boolean;
    className?: string;
}> = ({ messageId, result, defaultExpanded = false, className }) => {
    const [expanded, setExpanded] = React.useState(defaultExpanded);
    const contentId = React.useId();
    const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
    const outcome = outcomeLabels[result.outcome];

    return (
        <div
            className={cn('my-1 rounded-lg border border-border/60 bg-card text-card-foreground', className)}
            data-extension-ui={messageId}
            data-orchestration-result={result.outcome}
        >
            <div className="flex min-w-0 items-center gap-1 pr-1">
                <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-1.5 text-left typography-meta text-muted-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-focus"
                    aria-expanded={expanded}
                    aria-controls={contentId}
                    aria-label={`Result of worker ${result.title}`}
                    onClick={() => setExpanded((value) => !value)}
                >
                    <Icon name={outcomeIcons[result.outcome]} className={cn('size-3.5 shrink-0', outcomeTones[result.outcome])} />
                    <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium text-foreground">{result.title}</span>
                        <span> {outcome}</span>
                        {result.summary.length > 0 && <span>: {result.summary}</span>}
                    </span>
                    {result.role && (
                        <span className="shrink-0 rounded-full bg-interactive-hover px-2 py-0.5 typography-micro font-medium">
                            {result.role}
                        </span>
                    )}
                    <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5 shrink-0" />
                </button>
                <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    aria-label={`Open worker ${result.title}`}
                    title="Open worker"
                    onClick={() => setCurrentSession(result.sessionId, result.cwd)}
                >
                    <Icon name="external-link" className="size-3.5" />
                    Open
                </Button>
            </div>
            {expanded && (
                <div id={contentId} className="flex flex-col gap-2 border-t border-border/40 px-3 py-2">
                    {result.body.length > 0
                        ? <MarkdownRenderer messageId={`${messageId}:result`} content={result.body} className="text-sm" />
                        : <span className="typography-meta text-muted-foreground">No reply text.</span>}
                    <span className="min-w-0 truncate font-mono typography-micro text-muted-foreground">{result.cwd}</span>
                </div>
            )}
        </div>
    );
};
