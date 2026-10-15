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
 * The smallest the composer ever gets, with the informational branch row
 * above it: the card with its two line floor, the handle and the bottom
 * padding (152px) plus the row (34px). The branch row is dropped only when the
 * space the user can see cannot hold this. Measured on a 200px viewport in the
 * proof lab, where the container is 144px and the whole stack is 186px with the
 * row and 152px without.
 */
const COMPOSER_MIN_HEIGHT = 152;
const TARGET_ROW_HEIGHT = 34;

/** The part of the visual viewport that matters here: its size and where it is panned to. */
export interface VisualViewportBox {
    height: number;
    offsetTop: number;
}

/**
 * The part of the screen container the user can see, in the layout viewport's
 * coordinates: the container's own extent (a Capacitor shell shrinks the
 * element itself for the keyboard) cut by what the visual viewport shows,
 * `offsetTop` to `offsetTop + height` (a mobile browser only shrinks and pans
 * the visual viewport, so a panned header does not count against the height).
 */
function visibleContainerHeight(bound: Element, visualViewport: VisualViewportBox | undefined): number {
    const rectTop = bound.getBoundingClientRect().top;
    const top = Number.isFinite(rectTop) ? rectTop : 0;
    const bottom = top + bound.clientHeight;
    if (!visualViewport) return bound.clientHeight;
    const viewTop = visualViewport.offsetTop;
    return Math.max(0, Math.min(bottom, viewTop + visualViewport.height) - Math.max(top, viewTop));
}

/**
 * Whether the informational branch row above the composer fits: the visible
 * container holds the smallest composer stack with the row. A taller visible
 * area keeps the row, with its copy button. Unmeasured (no bound, or not laid
 * out) keeps it.
 */
export function composerAffordsTargetRow(bound: Element | null, visualViewport: VisualViewportBox | undefined): boolean {
    if (!bound || !(bound.clientHeight > 0)) return true;
    return visibleContainerHeight(bound, visualViewport) >= COMPOSER_MIN_HEIGHT + TARGET_ROW_HEIGHT;
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
