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
 * What the user can actually see of the screen container: a Capacitor shell
 * shrinks the element itself when the keyboard opens; a mobile browser only
 * shrinks the visual viewport. The smaller is what the user sees.
 */
function visibleHeightOf(bound: Element, visualViewportHeight: number | undefined): number {
    return Math.min(bound.clientHeight, visualViewportHeight ?? Number.POSITIVE_INFINITY);
}

/**
 * Below this visible height the composer cannot show the branch row and keep
 * the model row and send button in view. Measured on a 200px viewport: the
 * container is 144px, the composer 186px with the row (34px) and 152px
 * without, whose controls end inside the container.
 */
const TARGET_ROW_MIN_VISIBLE_HEIGHT = 300;

/**
 * Whether the informational branch row above the composer fits. Unmeasured
 * (no bound, or not laid out) keeps it.
 */
export function composerAffordsTargetRow(bound: Element | null, visualViewportHeight: number | undefined): boolean {
    if (!bound) return true;
    const visibleHeight = visibleHeightOf(bound, visualViewportHeight);
    return !(visibleHeight > 0) || visibleHeight >= TARGET_ROW_MIN_VISIBLE_HEIGHT;
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
    const visibleHeight = visibleHeightOf(bound, visualViewportHeight);
    if (!(visibleHeight > 0)) return byLines;
    const scrollerHeight = scroller.getBoundingClientRect().height;
    if (scrollerHeight === 0) return null;
    const chrome = surface ? Math.max(0, surface.getBoundingClientRect().height - scrollerHeight) : 0;
    const room = visibleHeight * COMPOSER_VISIBLE_FRACTION - chrome;
    return Math.min(byLines, Math.max(room, lineHeight * MIN_SCROLLER_LINES));
}
