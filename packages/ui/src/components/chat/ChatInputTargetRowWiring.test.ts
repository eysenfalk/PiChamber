import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Consumer wiring for #204. A static render cannot lay out a phone screen, so
 * the visible effect is covered by the lab proof and the geometry by
 * heightLimit.test.ts; this pins that ChatInput actually lets the measured
 * answer decide the branch row, on the session surface only.
 */
const source = readFileSync(join(__dirname, 'ChatInput.tsx'), 'utf8');

const hookCall = source.indexOf('useComposerTargetRowFits(');
const rowDecision = source.indexOf('const showComposerTargetRow = Boolean(');

test('the hook is measured against the composer form on the phone layout, not for a new session draft', () => {
  expect(hookCall).toBeGreaterThan(-1);
  const call = source.slice(hookCall, source.indexOf(');', hookCall));
  expect(call).toContain('composerFormRef');
  expect(call).toContain('isMobileForDraft && !newSessionDraftOpen');
});

test('the branch row of a session needs the measured fit; the new session draft keeps its selectors', () => {
  expect(rowDecision).toBeGreaterThan(hookCall);
  const decision = source.slice(rowDecision, source.indexOf(');', rowDecision));
  expect(decision).toContain('newSessionDraftOpen || (shouldShowDraftBranchSelector && targetRowFits)');
});
