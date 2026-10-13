import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';

type ComposerMinimizeToggleProps = {
    minimized: boolean;
    /** Whether the minimized pill should mention an unsent draft. */
    hasDraft: boolean;
    onMinimize: () => void;
    onRestore: () => void;
};

/**
 * Mobile only: gives the transcript the whole screen. Expanded, it is a slim
 * handle above the composer card; minimized, it is the only thing left of the
 * composer and brings the card back.
 */
export function ComposerMinimizeToggle({ minimized, hasDraft, onMinimize, onRestore }: ComposerMinimizeToggleProps) {
    if (minimized) {
        return (
            <button
                type="button"
                onClick={onRestore}
                aria-label="Show message field"
                title="Show message field"
                className={cn(
                    'flex h-10 w-full items-center justify-between rounded-full border border-border/80',
                    'bg-[var(--surface-subtle)] px-4 typography-ui-label text-muted-foreground',
                    'hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-focus',
                )}
            >
                <span>{hasDraft ? 'Message (draft)' : 'Message'}</span>
                <Icon name="arrow-up-s" className="size-5" />
            </button>
        );
    }
    return (
        <div className="flex h-6 w-full justify-center">
            <button
                type="button"
                onClick={onMinimize}
                aria-label="Minimize message field"
                title="Minimize message field"
                className={cn(
                    'flex h-6 w-16 items-center justify-center rounded-full text-muted-foreground',
                    'hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-focus',
                )}
            >
                <Icon name="arrow-down-s" className="size-5" />
            </button>
        </div>
    );
}
