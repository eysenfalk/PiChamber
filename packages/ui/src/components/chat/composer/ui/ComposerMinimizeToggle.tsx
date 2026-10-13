import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';

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
 *
 * The handle keeps a 44px tap target (`h-11`) but sits in a 24px row: the
 * negative margins let the target overlap the space around it instead of
 * adding height to the composer.
 */
export function ComposerMinimizeToggle({ minimized, hasDraft, onMinimize, onRestore }: ComposerMinimizeToggleProps) {
    if (minimized) {
        return (
            <Button
                variant="outline"
                onClick={onRestore}
                aria-label="Show message field"
                title="Show message field"
                className="h-11 w-full justify-between rounded-full px-4 normal-case text-muted-foreground"
            >
                <span>{hasDraft ? 'Message (draft)' : 'Message'}</span>
                <Icon name="arrow-up-s" className="size-5" />
            </Button>
        );
    }
    return (
        <div className="flex h-6 w-full items-center justify-center">
            <Button
                variant="ghost"
                onClick={onMinimize}
                aria-label="Minimize message field"
                title="Minimize message field"
                className="-my-2.5 h-11 w-16 rounded-full border-0 px-0 text-muted-foreground"
            >
                <Icon name="arrow-down-s" className="size-5" />
            </Button>
        </div>
    );
}
