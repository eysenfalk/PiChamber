/**
 * How tall the composer's text scroller may grow before it scrolls inside
 * itself.
 *
 * With a bound (mobile), the whole composer (handle, card padding, footer,
 * attachments and the text) takes at most a third of what the user can
 * actually see, so the transcript above keeps the rest even with the keyboard
 * open. The text scroller gets what is left after the measured chrome. Without
 * a bound (desktop) only the line limit applies.
 */
const COMPOSER_VISIBLE_FRACTION = 1 / 3;

/**
 * On a very small visible height the chrome alone can exceed the third. The
 * field then keeps this many lines so typing stays possible; the composer is
 * larger than a third in that case, and the user can minimize it.
 */
const MIN_SCROLLER_LINES = 2;

interface ComposerScrollerLimitInput {
    lineHeight: number;
    maxLines: number;
    /** Bounding screen container, or null when there is no bound (desktop). */
    bound: Element | null;
    /** The mobile browser's visual viewport, which shrinks with the keyboard. */
    visualViewportHeight: number | undefined;
    /** The whole composer: handle and card. Null measures no chrome. */
    surface: Element | null;
    /** The text scroller inside `surface`. */
    scroller: Element;
}

/**
 * Max height of the text scroller in px, or null while the composer is not
 * laid out (minimized), so the limit is recomputed when it comes back.
 */
export function composerScrollerLimit({
    lineHeight,
    maxLines,
    bound,
    visualViewportHeight,
    surface,
    scroller,
}: ComposerScrollerLimitInput): number | null {
    const byLines = lineHeight * maxLines;
    if (!bound) return byLines;
    // A Capacitor shell shrinks the element itself when the keyboard opens; a
    // mobile browser only shrinks the visual viewport. The smaller is what the
    // user sees.
    const visibleHeight = Math.min(bound.clientHeight, visualViewportHeight ?? Number.POSITIVE_INFINITY);
    if (!(visibleHeight > 0)) return byLines;
    const scrollerHeight = scroller.getBoundingClientRect().height;
    if (scrollerHeight === 0) return null;
    const chrome = surface ? Math.max(0, surface.getBoundingClientRect().height - scrollerHeight) : 0;
    const room = visibleHeight * COMPOSER_VISIBLE_FRACTION - chrome;
    return Math.min(byLines, Math.max(room, lineHeight * MIN_SCROLLER_LINES));
}
