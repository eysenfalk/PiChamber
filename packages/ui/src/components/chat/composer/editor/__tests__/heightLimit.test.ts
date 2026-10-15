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
    // The smallest composer is 152px (handle, card with its two line floor,
    // bottom padding); the branch row adds 34. On a 200px viewport the screen
    // container is 144px (56px header), so with the row the model row and the
    // send button fall below the visible area (#204).
    const container = (clientHeight: number, top = 56) =>
        ({ clientHeight, getBoundingClientRect: () => ({ top, height: clientHeight }) }) as unknown as Element;

    test('a 200px viewport leaves the container too short for the row', () => {
        expect(composerAffordsTargetRow(container(144), 200)).toBe(false);
    });

    test('the row stays until the container really cannot hold the smallest stack with it', () => {
        expect(composerAffordsTargetRow(container(185), undefined)).toBe(false);
        expect(composerAffordsTargetRow(container(186), undefined)).toBe(true);
    });

    test('the same boundary holds in viewport terms, through the header', () => {
        // Container as tall as the viewport minus the 56px header.
        expect(composerAffordsTargetRow(container(241 - 56), 241)).toBe(false);
        expect(composerAffordsTargetRow(container(242 - 56), 242)).toBe(true);
    });

    test('a 300px viewport keeps the row it has room for', () => {
        expect(composerAffordsTargetRow(container(244), 300)).toBe(true);
    });

    test('the shrunken visual viewport counts when the browser pans instead of resizing', () => {
        expect(composerAffordsTargetRow(container(800), 200)).toBe(false);
        expect(composerAffordsTargetRow(container(800), 300)).toBe(true);
    });

    test('a landscape phone without the keyboard and a portrait phone with it keep the row', () => {
        expect(composerAffordsTargetRow(container(334), 390)).toBe(true);
        expect(composerAffordsTargetRow(container(444), 500)).toBe(true);
    });

    test('a container without a top edge reading is judged by its height and the viewport alone', () => {
        expect(composerAffordsTargetRow(el({ clientHeight: 144 }), 200)).toBe(false);
        expect(composerAffordsTargetRow(el({ clientHeight: 244 }), 300)).toBe(true);
    });

    test('an unmeasured container keeps the row', () => {
        expect(composerAffordsTargetRow(el({ clientHeight: 0 }), undefined)).toBe(true);
        expect(composerAffordsTargetRow(null, 200)).toBe(true);
    });
});
