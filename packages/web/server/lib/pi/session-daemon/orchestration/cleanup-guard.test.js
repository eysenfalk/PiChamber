import { describe, expect, it } from 'vitest';

import { cleanupRefusal } from './cleanup-guard.js';

const merged = { number: 5, state: 'merged', mergedAt: '2026-10-13T12:00:00Z', headSha: 'a'.repeat(40) };
const facts = { branch: '9-fix', pr: merged, localTip: 'a'.repeat(40), clean: true, live: false };

describe('cleanupRefusal', () => {
  it('allows a merged pull request whose head is the local tip, a clean tree and no live run', () => {
    expect(cleanupRefusal(facts)).toBeNull();
    // The local branch is already gone after an earlier partial cleanup.
    expect(cleanupRefusal({ ...facts, localTip: undefined })).toBeNull();
  });

  it.each([
    ['no branch', { branch: undefined }, /no branch/],
    ['main', { branch: 'main' }, /main is never/],
    ['dev', { branch: 'dev' }, /dev is never/],
    ['a failed lookup', { lookupError: 'rate limited' }, /lookup failed: rate limited/],
    ['no pull request', { pr: null }, /No pull request exists for 9-fix/],
    ['an open pull request', { pr: { ...merged, state: 'open', mergedAt: null } }, /still open/],
    ['a closed unmerged pull request', { pr: { ...merged, state: 'closed', mergedAt: null } }, /closed without a merge; ask the owner/],
    ['a later local commit', { localTip: 'b'.repeat(40) }, /not at the merged head/],
    ['a merged head without sha', { pr: { ...merged, headSha: null } }, /not at the merged head/],
    ['a dirty worktree', { clean: false }, /uncommitted/],
    ['a live run', { live: true }, /running or waiting/],
  ])('refuses %s', (_name, change, reason) => {
    expect(cleanupRefusal({ ...facts, ...change })).toMatch(reason);
  });

  it('decides a helper by its served pull request and the live run only', () => {
    expect(cleanupRefusal({ helper: true, pr: merged, live: false })).toBeNull();
    expect(cleanupRefusal({ helper: true, pr: { ...merged, state: 'open', mergedAt: null }, live: false })).toMatch(/still open/);
    expect(cleanupRefusal({ helper: true, pr: merged, live: true })).toMatch(/running/);
    expect(cleanupRefusal({ helper: true, pr: null, live: false })).toMatch(/helper serves was not found/);
  });
});
