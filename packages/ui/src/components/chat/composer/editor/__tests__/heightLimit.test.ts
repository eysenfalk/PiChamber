import { describe, expect, test } from 'bun:test';

import { composerHeightLimit, visibleBoundHeight } from '../heightLimit';

describe('composerHeightLimit', () => {
    test('takes a third of the visible area and scrolls beyond it', () => {
        expect(composerHeightLimit({ lineHeight: 24, maxLines: 16, visibleHeight: 300 })).toBe(100);
    });

    test('a taller visible area gives a proportionally taller limit', () => {
        expect(composerHeightLimit({ lineHeight: 24, maxLines: 16, visibleHeight: 600 })).toBe(200);
    });

    test('the line limit still caps a very tall screen', () => {
        expect(composerHeightLimit({ lineHeight: 24, maxLines: 5, visibleHeight: 2000 })).toBe(120);
    });

    test('without a bound only the line limit applies (desktop)', () => {
        expect(composerHeightLimit({ lineHeight: 24, maxLines: 5, visibleHeight: null })).toBe(120);
    });

    test('an unmeasured bound does not collapse the editor', () => {
        expect(composerHeightLimit({ lineHeight: 24, maxLines: 5, visibleHeight: 0 })).toBe(120);
    });
});

describe('visibleBoundHeight', () => {
    test('uses the shrunken visual viewport when the browser pans instead of resizing', () => {
        expect(visibleBoundHeight({ clientHeight: 800 } as Element, 450)).toBe(450);
    });

    test('uses the element when the shell already shrank for the keyboard', () => {
        expect(visibleBoundHeight({ clientHeight: 420 } as Element, 800)).toBe(420);
    });

    test('works without a visual viewport', () => {
        expect(visibleBoundHeight({ clientHeight: 700 } as Element, undefined)).toBe(700);
    });
});
