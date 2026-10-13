/**
 * How tall the composer's scroller may grow before it scrolls inside itself.
 *
 * With a bound (mobile), the text field takes at most a third of what the
 * user can actually see, so the transcript above keeps the rest even with the
 * keyboard open. Without a bound (desktop) only the line limit applies.
 */
const COMPOSER_VISIBLE_FRACTION = 1 / 3;

interface ComposerHeightLimitInput {
    lineHeight: number;
    maxLines: number;
    /** Visible height of the bounding screen, or null when there is no bound. */
    visibleHeight: number | null;
}

export function composerHeightLimit({ lineHeight, maxLines, visibleHeight }: ComposerHeightLimitInput): number {
    const byLines = lineHeight * maxLines;
    if (visibleHeight === null || !(visibleHeight > 0)) return byLines;
    return Math.min(byLines, visibleHeight * COMPOSER_VISIBLE_FRACTION);
}

/**
 * The visible height of a bounding element. A Capacitor shell shrinks the
 * element itself when the keyboard opens; a mobile browser only shrinks the
 * visual viewport, so the smaller of the two is what the user sees.
 */
export function visibleBoundHeight(bound: Element, visualViewportHeight: number | undefined): number {
    return Math.min(bound.clientHeight, visualViewportHeight ?? Number.POSITIVE_INFINITY);
}
