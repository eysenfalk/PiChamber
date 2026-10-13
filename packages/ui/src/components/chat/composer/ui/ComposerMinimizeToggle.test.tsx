import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ComposerMinimizeToggle } from './ComposerMinimizeToggle';

const render = (props: Partial<React.ComponentProps<typeof ComposerMinimizeToggle>> = {}) =>
    renderToStaticMarkup(
        React.createElement(ComposerMinimizeToggle, {
            minimized: false,
            hasDraft: false,
            onMinimize: mock(),
            onRestore: mock(),
            ...props,
        }),
    );

describe('ComposerMinimizeToggle', () => {
    test('expanded, offers only to minimize', () => {
        const html = render();
        expect(html).toContain('aria-label="Minimize message field"');
        expect(html).not.toContain('Show message field');
    });

    test('minimized, offers only to bring the field back', () => {
        const html = render({ minimized: true });
        expect(html).toContain('aria-label="Show message field"');
        expect(html).not.toContain('Minimize message field');
        expect(html).toContain('Message');
    });

    test('minimized with unsent text says there is a draft', () => {
        expect(render({ minimized: true, hasDraft: true })).toContain('Message (draft)');
    });
});
