import { describe, expect, test } from 'bun:test';
import type { GitStatus } from '@/lib/api/types';
import type { PrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { buildWorktreePills, formatAutoFetchNote, summarizeProjectDirty, type WorktreeStatusRecord } from './worktreePills';

const status = (overrides: Partial<GitStatus> = {}): GitStatus => ({
  current: 'feature',
  tracking: 'origin/feature',
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
  ...overrides,
});

const ready = (value: GitStatus | null, fetchedAt = 5_000): WorktreeStatusRecord => ({
  kind: 'ready',
  status: value,
  fetchedAt,
});

const files = (count: number): GitStatus['files'] =>
  Array.from({ length: count }, (_, index) => ({ path: `f${index}.ts`, index: ' ', working_dir: 'M' }));

const pr = (visualState: PrVisualSummary['visualState'], number = 42): PrVisualSummary => ({ visualState, number });

describe('buildWorktreePills', () => {
  test('a dirty checkout shows the changed file count and no clean pill', () => {
    const { pills } = buildWorktreePills(ready(status({ files: files(3), isClean: false })), null);
    expect(pills).toEqual([{ kind: 'dirty', count: 3 }]);
  });

  test('a clean checkout with an upstream shows only the clean pill', () => {
    expect(buildWorktreePills(ready(status()), null).pills).toEqual([{ kind: 'clean' }]);
  });

  test('ahead and behind appear only when not zero, ahead first', () => {
    expect(buildWorktreePills(ready(status({ ahead: 13, behind: 10 })), null).pills).toEqual([
      { kind: 'clean' },
      { kind: 'ahead', count: 13 },
      { kind: 'behind', count: 10 },
    ]);
    expect(buildWorktreePills(ready(status({ ahead: 0, behind: 2 })), null).pills).toEqual([
      { kind: 'clean' },
      { kind: 'behind', count: 2 },
    ]);
  });

  test('no upstream is its own pill', () => {
    expect(buildWorktreePills(ready(status({ tracking: null })), null).pills).toEqual([
      { kind: 'clean' },
      { kind: 'no-upstream' },
    ]);
  });

  test('attention comes first and prefers merge, then rebase, then attentionReason', () => {
    const merge = status({ mergeInProgress: { head: 'abc1234', message: 'm' }, rebaseInProgress: { headName: 'x', onto: 'y' } });
    expect(buildWorktreePills(ready(merge), null).pills[0]).toEqual({ kind: 'attention', reason: 'merge' });
    const rebase = status({ rebaseInProgress: { headName: 'x', onto: 'y' }, attentionReason: 'revert' });
    expect(buildWorktreePills(ready(rebase), null).pills[0]).toEqual({ kind: 'attention', reason: 'rebase' });
    const other = status({ attentionReason: 'cherry-pick', files: files(1), isClean: false });
    expect(buildWorktreePills(ready(other), null).pills).toEqual([
      { kind: 'attention', reason: 'cherry-pick' },
      { kind: 'dirty', count: 1 },
    ]);
  });

  test('null in-progress fields and a null attentionReason add no attention pill', () => {
    const quiet = status({ mergeInProgress: null, rebaseInProgress: null, attentionReason: null });
    expect(buildWorktreePills(ready(quiet), null).pills).toEqual([{ kind: 'clean' }]);
  });

  test('a failed status shows only the unknown pill and carries the error', () => {
    const failed: WorktreeStatusRecord = {
      kind: 'failed',
      error: 'git exploded',
      failedAt: 9_000,
      lastKnown: { kind: 'ready', status: status({ files: files(2), ahead: 3 }), fetchedAt: 4_000 },
    };
    expect(buildWorktreePills(failed, null)).toEqual({
      pills: [{ kind: 'unknown' }],
      fetchedAt: 4_000,
      error: 'git exploded',
    });
  });

  test('a pull request pill comes last with its number and state, also next to a failure', () => {
    expect(buildWorktreePills(ready(status({ tracking: null })), pr('open', 7)).pills).toEqual([
      { kind: 'clean' },
      { kind: 'no-upstream' },
      { kind: 'pull-request', number: 7, state: 'open' },
    ]);
    const failed: WorktreeStatusRecord = { kind: 'failed', error: 'x', failedAt: 1, lastKnown: null };
    expect(buildWorktreePills(failed, pr('merged', 9))).toEqual({
      pills: [{ kind: 'unknown' }, { kind: 'pull-request', number: 9, state: 'merged' }],
      fetchedAt: null,
      error: 'x',
    });
  });

  test('no record yet shows no git pill but keeps the pull request', () => {
    expect(buildWorktreePills(undefined, null)).toEqual({ pills: [], fetchedAt: null, error: null });
    expect(buildWorktreePills(undefined, pr('draft', 3)).pills).toEqual([{ kind: 'pull-request', number: 3, state: 'draft' }]);
  });

  test('a directory that is not a git repository shows no git pill', () => {
    expect(buildWorktreePills(ready(null, 6_000), null)).toEqual({ pills: [], fetchedAt: 6_000, error: null });
  });

  test('the fetch time of a ready record is reported for the tooltip', () => {
    expect(buildWorktreePills(ready(status({ ahead: 1 }), 12_345), null).fetchedAt).toBe(12_345);
  });
});

describe('summarizeProjectDirty', () => {
  test('counts worktrees with changes, not files', () => {
    const rollup = summarizeProjectDirty([
      ready(status({ files: files(5), isClean: false })),
      ready(status({ files: files(1), isClean: false })),
      ready(status()),
    ]);
    expect(rollup).toEqual({ dirtyWorktrees: 2, unknownWorktrees: 0 });
  });

  test('reports failed worktrees separately and skips missing and non repository records', () => {
    const failed: WorktreeStatusRecord = { kind: 'failed', error: 'x', failedAt: 1, lastKnown: null };
    const rollup = summarizeProjectDirty([failed, undefined, ready(null), ready(status({ files: files(1), isClean: false }))]);
    expect(rollup).toEqual({ dirtyWorktrees: 1, unknownWorktrees: 1 });
  });

  test('is zero for no records', () => {
    expect(summarizeProjectDirty([])).toEqual({ dirtyWorktrees: 0, unknownWorktrees: 0 });
  });
});

describe('formatAutoFetchNote', () => {
  const time = (at: number) => `t${at}`;

  test('is empty while Auto fetch has not run', () => {
    expect(formatAutoFetchNote(undefined, time)).toBe('');
    expect(formatAutoFetchNote({ lastFetchedAt: null, lastError: null, lastAttemptAt: 1 }, time)).toBe('');
  });

  test('shows the last fetch time after a success', () => {
    expect(formatAutoFetchNote({ lastFetchedAt: 7, lastError: null, lastAttemptAt: 7 }, time)).toBe(' · Last fetch t7');
  });

  test('shows the failure, even when an earlier fetch succeeded', () => {
    expect(formatAutoFetchNote({ lastFetchedAt: 7, lastError: 'credentials required', lastAttemptAt: 9 }, time))
      .toBe(' · Auto fetch failed: credentials required');
  });
});
