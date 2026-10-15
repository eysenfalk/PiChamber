import React from 'react';

import { composerAffordsTargetRow } from '../editor/heightLimit';

/**
 * Mobile: whether the informational branch row above the composer fits the
 * visible height (see `composerAffordsTargetRow`). Always true when not
 * enabled (desktop, tablet, mini chat have no bound).
 *
 * Re-measures when the container resizes (a Capacitor shell shrinks it for the
 * keyboard) and on visual viewport resizes and pans (a mobile browser shrinks
 * and pans only that; a pan alone changes which part of the container shows).
 */
export const useComposerTargetRowFits = (
    formRef: React.RefObject<HTMLElement | null>,
    enabled: boolean,
): boolean => {
    const [fits, setFits] = React.useState(true);

    React.useLayoutEffect(() => {
        if (!enabled) return;
        const bound = formRef.current?.closest('[data-composer-bound]') ?? null;
        const measure = () => setFits(composerAffordsTargetRow(bound, window.visualViewport ?? undefined));
        measure();
        const observer = typeof ResizeObserver === 'undefined' || !bound ? null : new ResizeObserver(measure);
        if (bound) observer?.observe(bound);
        const visualViewport = window.visualViewport;
        visualViewport?.addEventListener('resize', measure);
        visualViewport?.addEventListener('scroll', measure);
        return () => {
            observer?.disconnect();
            visualViewport?.removeEventListener('resize', measure);
            visualViewport?.removeEventListener('scroll', measure);
        };
    }, [enabled, formRef]);

    return enabled ? fits : true;
};
