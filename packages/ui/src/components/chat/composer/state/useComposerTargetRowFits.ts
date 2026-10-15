import React from 'react';

import { composerAffordsTargetRow } from '../editor/heightLimit';

/**
 * Mobile: whether the informational branch row above the composer fits the
 * visible height (see `composerAffordsTargetRow`). Always true when not
 * enabled (desktop, tablet, mini chat have no bound).
 *
 * Re-measures when the container resizes (a Capacitor shell shrinks it for the
 * keyboard) and on visual viewport resizes (a mobile browser shrinks only
 * that), the same two sources the text scroller limit listens to.
 */
export const useComposerTargetRowFits = (
    formRef: React.RefObject<HTMLElement | null>,
    enabled: boolean,
): boolean => {
    const [fits, setFits] = React.useState(true);

    React.useLayoutEffect(() => {
        if (!enabled) return;
        const bound = formRef.current?.closest('[data-composer-bound]') ?? null;
        const measure = () => setFits(composerAffordsTargetRow(bound, window.visualViewport?.height));
        measure();
        const observer = typeof ResizeObserver === 'undefined' || !bound ? null : new ResizeObserver(measure);
        if (bound) observer?.observe(bound);
        const visualViewport = window.visualViewport;
        visualViewport?.addEventListener('resize', measure);
        return () => {
            observer?.disconnect();
            visualViewport?.removeEventListener('resize', measure);
        };
    }, [enabled, formRef]);

    return enabled ? fits : true;
};
