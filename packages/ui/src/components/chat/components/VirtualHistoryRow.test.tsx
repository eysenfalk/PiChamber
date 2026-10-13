import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { VirtualHistoryRow } from './VirtualHistoryRow';

// Layout is not available in unit tests. The measured overlap itself (list
// container height vs. rendered row height in a 390x844 browser) is covered by
// the real browser check described in the pull request; this pins the contract
// that keeps child margins inside the measured row box.
describe('VirtualHistoryRow', () => {
    test('is its own block formatting context so child margins stay inside the measured box', () => {
        const markup = renderToStaticMarkup(
            <VirtualHistoryRow index={3} entryKey="turn:abc" measureElement={() => undefined}>
                <section style={{ marginBottom: 4 }} />
            </VirtualHistoryRow>,
        );
        expect(markup).toContain('class="flow-root"');
        expect(markup).toContain('data-index="3"');
        expect(markup).toContain('data-turn-entry="turn:abc"');
    });
});
