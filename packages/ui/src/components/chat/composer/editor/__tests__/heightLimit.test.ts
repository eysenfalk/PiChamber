import { describe, expect, test } from 'bun:test';

import { composerAffordsTargetRow, composerScrollerLimit } from '../heightLimit';

const el = (size: { clientHeight?: number; height?: number }) =>
    ({ clientHeight: size.clientHeight ?? 0, getBoundingClientRect: () => ({ height: size.height ?? 0 }) }) as unknown as Element;

/**
 * A composer whose text is long: the scroller fills whatever max height it is
 * given, and the surrounding chrome stays the same size. Returns the height of
 * the whole composer after the limit applied.
 */
const composerHeightAfterLimit = (visible: number, chrome: number, viewport?: number) => {
    const lineHeight = 24;
    const contentHeight = 24 * 24;
    const bound = el({ clientHeight: visible });
    const unlimitedScroller = Math.min(contentHeight, lineHeight * 16);
    const limit = composerScrollerLimit({
        lineHeight,
        maxLines: 16,
        bound,
        visualViewportHeight: viewport,
        surface: el({ height: chrome + unlimitedScroller }),
        scroller: el({ height: unlimitedScroller }),
    });
    return chrome + Math.min(unlimitedScroller, limit ?? unlimitedScroller);
};

describe('composerScrollerLimit', () => {
    test('the whole composer, chrome included, stays within a third of the visible area', () => {
        expect(composerHeightAfterLimit(600, 100)).toBe(200);
        expect(composerHeightAfterLimit(900, 100)).toBe(300);
    });

    test('on 300px visible, chrome that eats the third leaves the field its two line floor, not more', () => {
        // 100px of chrome leaves nothing of the 100px third, so the field keeps its two line floor.
        expect(composerHeightAfterLimit(300, 100)).toBe(100 + 48);
    });

    test('a smaller chrome leaves more of the third to the text', () => {
        expect(composerHeightAfterLimit(300, 40)).toBe(100);
    });

    test('the shrunken visual viewport counts when the browser pans instead of resizing', () => {
        expect(composerHeightAfterLimit(800, 100, 450)).toBe(150);
    });

    test('the element counts when the shell already shrank for the keyboard', () => {
        expect(composerHeightAfterLimit(420, 90, 800)).toBe(140);
    });

    test('the line limit still caps a very tall screen', () => {
        expect(composerHeightAfterLimit(3000, 100)).toBe(100 + 24 * 16);
    });

    test('without a bound only the line limit applies (desktop)', () => {
        expect(
            composerScrollerLimit({
                lineHeight: 24,
                maxLines: 5,
                bound: null,
                visualViewportHeight: 300,
                surface: null,
                scroller: el({ height: 120 }),
            }),
        ).toBe(120);
    });

    test('an unmeasured bound does not collapse the editor', () => {
        expect(
            composerScrollerLimit({
                lineHeight: 24,
                maxLines: 5,
                bound: el({ clientHeight: 0 }),
                visualViewportHeight: undefined,
                surface: null,
                scroller: el({ height: 120 }),
            }),
        ).toBe(120);
    });

    test('a minimized composer is not measured', () => {
        expect(
            composerScrollerLimit({
                lineHeight: 24,
                maxLines: 16,
                bound: el({ clientHeight: 600 }),
                visualViewportHeight: undefined,
                surface: el({ height: 24 }),
                scroller: el({ height: 0 }),
            }),
        ).toBeNull();
    });
});

describe('composerAffordsTargetRow', () => {
    // The composer without the branch row is 152px (handle, card with its two
    // line floor, bottom padding); the row adds 34 more. On a 200px viewport
    // the screen container is 144px, so with the row the model row and the
    // send button fall below the visible area (#204).
    test('a 200px viewport leaves the container too short for the row, portrait and landscape', () => {
        expect(composerAffordsTargetRow(el({ clientHeight: 144 }), 200)).toBe(false);
    });

    test('the shrunken visual viewport counts when the browser pans instead of resizing', () => {
        expect(composerAffordsTargetRow(el({ clientHeight: 800 }), 200)).toBe(false);
    });

    test('a landscape phone without the keyboard and a portrait phone with it keep the row', () => {
        expect(composerAffordsTargetRow(el({ clientHeight: 334 }), 390)).toBe(true);
        expect(composerAffordsTargetRow(el({ clientHeight: 444 }), 500)).toBe(true);
    });

    test('an unmeasured container keeps the row', () => {
        expect(composerAffordsTargetRow(el({ clientHeight: 0 }), undefined)).toBe(true);
        expect(composerAffordsTargetRow(null, 200)).toBe(true);
    });
});
