import * as React from 'react';

import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import type { SupervisorReply, SupervisorRequest } from '@/lib/pi/supervisor-ui';
import { MarkdownRenderer } from '../../../MarkdownRenderer';
import { ExtensionDisclosureRow } from './ExtensionDisclosureRow';

const reasonIcons: Record<string, IconName> = {
    Decision: 'question',
    Interview: 'chat-3',
    Progress: 'information',
};

const reasonTones: Record<string, string> = {
    Decision: 'bg-status-warning/15 text-status-warning',
    Interview: 'bg-status-info/15 text-status-info',
    Progress: 'bg-interactive-hover text-muted-foreground',
};

const DetailList: React.FC<{ details: SupervisorRequest['details'] }> = ({ details }) => (
    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1 typography-meta">
        {details.map((row) => (
            <React.Fragment key={row.label}>
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="min-w-0 break-words whitespace-pre-wrap font-mono">{row.value}</dd>
            </React.Fragment>
        ))}
    </dl>
);

export const SupervisorRequestRow: React.FC<{
    messageId: string;
    request: SupervisorRequest;
    defaultDetailsExpanded?: boolean;
    className?: string;
}> = ({ messageId, request, defaultDetailsExpanded = false, className }) => {
    const [detailsExpanded, setDetailsExpanded] = React.useState(defaultDetailsExpanded);
    const detailsId = React.useId();

    return (
        <div
            className={cn('my-1 flex flex-col gap-1.5 rounded-lg border border-border/60 bg-card px-3 py-2 text-card-foreground', className)}
            data-extension-ui={messageId}
            data-supervisor-message="request"
        >
            <div className="flex min-w-0 items-center gap-2 typography-meta">
                <Icon name={reasonIcons[request.reasonLabel] ?? 'question'} className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate font-medium">{request.agent}</span>
                <span className={cn('shrink-0 rounded-full px-2 py-0.5 typography-micro font-medium', reasonTones[request.reasonLabel])}>
                    {request.reasonLabel}
                </span>
                <button
                    type="button"
                    className="ml-auto flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-focus"
                    aria-expanded={detailsExpanded}
                    aria-controls={detailsId}
                    aria-label={`Request details from ${request.agent}`}
                    onClick={() => setDetailsExpanded((value) => !value)}
                >
                    Details
                    <Icon name={detailsExpanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" />
                </button>
            </div>
            <MarkdownRenderer messageId={`${messageId}:question`} content={request.question} className="text-sm" />
            {detailsExpanded && (
                <div id={detailsId} className="border-t border-border/40 pt-2">
                    <DetailList details={request.details} />
                </div>
            )}
        </div>
    );
};

export const SupervisorReplyRow: React.FC<{
    messageId: string;
    reply: SupervisorReply;
    defaultExpanded?: boolean;
    className?: string;
}> = ({ messageId, reply, defaultExpanded = false, className }) => (
    <ExtensionDisclosureRow
        messageId={messageId}
        dataAttributes={{ 'data-supervisor-message': 'reply' }}
        icon="corner-down-left"
        label={`Reply to ${reply.agent}`}
        defaultExpanded={defaultExpanded}
        className={className}
        summary={(
            <>
                <span className="font-medium text-foreground">Reply to {reply.agent}</span>
                {reply.summary.length > 0 && <span>: {reply.summary}</span>}
            </>
        )}
    >
        <div className="flex flex-col gap-2">
            <MarkdownRenderer messageId={`${messageId}:reply`} content={reply.message} className="text-sm" />
            <DetailList details={reply.details} />
        </div>
    </ExtensionDisclosureRow>
);
