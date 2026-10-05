import * as React from 'react';

import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';

interface ExtensionDisclosureRowProps {
    /** Chat message id, exposed as `data-extension-ui` like every extension card. */
    messageId: string;
    icon: IconName;
    /** The collapsed row content: one line, truncated by the row. */
    summary: React.ReactNode;
    /** Accessible name of the toggle, e.g. "Reply to worker". */
    label: string;
    /** Render expanded on first mount (tests and persisted views). */
    defaultExpanded?: boolean;
    /** Extra `data-*` attributes for the row root. */
    dataAttributes?: Record<`data-${string}`, string>;
    className?: string;
    children: React.ReactNode;
}

/**
 * One collapsed row that expands to its content. The content mounts only while
 * expanded, so long extension transcripts do not pay for hidden Markdown.
 */
export const ExtensionDisclosureRow: React.FC<ExtensionDisclosureRowProps> = ({
    messageId,
    icon,
    summary,
    label,
    defaultExpanded = false,
    dataAttributes,
    className,
    children,
}) => {
    const [expanded, setExpanded] = React.useState(defaultExpanded);
    const contentId = React.useId();

    return (
        <div
            className={cn('my-1 rounded-lg border border-border/60 bg-card text-card-foreground', className)}
            data-extension-ui={messageId}
            data-extension-disclosure={expanded ? 'expanded' : 'collapsed'}
            {...dataAttributes}
        >
            <button
                type="button"
                className="flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-1.5 text-left typography-meta text-muted-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-focus"
                aria-expanded={expanded}
                aria-controls={contentId}
                aria-label={label}
                onClick={() => setExpanded((value) => !value)}
            >
                <Icon name={icon} className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{summary}</span>
                <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5 shrink-0" />
            </button>
            {expanded && (
                <div id={contentId} className="border-t border-border/40 px-3 py-2">
                    {children}
                </div>
            )}
        </div>
    );
};
