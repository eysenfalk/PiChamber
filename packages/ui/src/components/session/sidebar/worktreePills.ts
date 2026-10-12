import type { GitStatus } from '@/lib/api/types';
import type { PrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import type { WorktreeStatusEntry } from './worktreeStatusScheduler';

/**
 * Pill model for a worktree row (decision D4 of #95). Pure data: the renderer
 * owns icons, colors and every user visible string.
 */

type WorktreeAttentionReason = NonNullable<GitStatus['attentionReason']>;

export type WorktreePill =
  /** Staged + unstaged + untracked files. */
  | { kind: 'dirty'; count: number }
  | { kind: 'clean' }
  | { kind: 'ahead'; count: number }
  | { kind: 'behind'; count: number }
  | { kind: 'no-upstream' }
  /** Conflict, rebase, merge or another operation that needs the owner. */
  | { kind: 'attention'; reason: WorktreeAttentionReason }
  /** The status request failed; nothing is known about the checkout. */
  | { kind: 'unknown' }
  | { kind: 'pull-request'; number: number; state: PrVisualSummary['visualState'] };

export type WorktreePills = {
  pills: WorktreePill[];
  /** When the shown status was fetched, for the tooltip of the ahead and behind pills. */
  fetchedAt: number | null;
  /** The failure message when a pill is 'unknown'. */
  error: string | null;
};

/** The scheduler records null for a directory that is not a git repository. */
export type WorktreeStatusRecord = WorktreeStatusEntry<GitStatus | null>;

const attentionReason = (status: GitStatus): WorktreeAttentionReason | null => {
  if (status.mergeInProgress) return 'merge';
  if (status.rebaseInProgress) return 'rebase';
  return status.attentionReason ?? null;
};

const pullRequestPill = (pr: PrVisualSummary | null): WorktreePill[] =>
  pr ? [{ kind: 'pull-request', number: pr.number, state: pr.visualState }] : [];

/**
 * Pills in display order: attention, changes, ahead, behind, no upstream,
 * pull request. A row whose status has not been fetched yet shows no git pill,
 * a failed one shows only 'unknown', and a directory that is not a repository
 * shows none.
 */
export const buildWorktreePills = (
  record: WorktreeStatusRecord | undefined,
  pr: PrVisualSummary | null,
): WorktreePills => {
  if (!record) return { pills: pullRequestPill(pr), fetchedAt: null, error: null };

  if (record.kind === 'failed') {
    return {
      pills: [{ kind: 'unknown' }, ...pullRequestPill(pr)],
      fetchedAt: record.lastKnown?.fetchedAt ?? null,
      error: record.error,
    };
  }

  const status = record.status;
  if (!status) return { pills: pullRequestPill(pr), fetchedAt: record.fetchedAt, error: null };

  const pills: WorktreePill[] = [];
  const reason = attentionReason(status);
  if (reason) pills.push({ kind: 'attention', reason });

  const changed = status.files.length;
  pills.push(changed > 0 ? { kind: 'dirty', count: changed } : { kind: 'clean' });

  if (status.ahead > 0) pills.push({ kind: 'ahead', count: status.ahead });
  if (status.behind > 0) pills.push({ kind: 'behind', count: status.behind });
  if (!status.tracking) pills.push({ kind: 'no-upstream' });

  pills.push(...pullRequestPill(pr));
  return { pills, fetchedAt: record.fetchedAt, error: null };
};

type ProjectDirtyRollup = {
  /** Worktrees with at least one changed file: the N of the collapsed project's "N dirty". */
  dirtyWorktrees: number;
  /** Worktrees whose status failed, so the count may be too low. */
  unknownWorktrees: number;
};

export const summarizeProjectDirty = (
  records: Iterable<WorktreeStatusRecord | undefined>,
): ProjectDirtyRollup => {
  let dirtyWorktrees = 0;
  let unknownWorktrees = 0;
  for (const record of records) {
    if (!record) continue;
    if (record.kind === 'failed') {
      unknownWorktrees += 1;
      continue;
    }
    if (record.status && record.status.files.length > 0) dirtyWorktrees += 1;
  }
  return { dirtyWorktrees, unknownWorktrees };
};
