import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import {
  getGitHubPrStatusKey,
  useEnsureGitHubPrStatus,
  usePrVisualSummary,
  type PrVisualSummary,
} from '@/stores/useGitHubPrStatusStore';
import { buildWorktreePills, type WorktreePill, type WorktreeStatusRecord } from './worktreePills';

const ATTENTION_LABEL: Record<NonNullable<Extract<WorktreePill, { kind: 'attention' }>['reason']>, string> = {
  merge: 'Merge in progress',
  rebase: 'Rebase in progress',
  'cherry-pick': 'Cherry-pick in progress',
  revert: 'Revert in progress',
  bisect: 'Bisect in progress',
};

const pullRequestStatusLabel = (summary: PrVisualSummary): string => {
  switch (summary.visualState) {
    case 'merged':
      return 'Merged';
    case 'open':
      return summary.canMerge === true || summary.mergeableState === 'clean' || summary.checks?.state === 'success'
        ? 'Ready to merge'
        : 'Open';
    case 'blocked':
      return summary.mergeableState === 'dirty' ? 'Merge conflicts' : 'Merge blocked';
    case 'draft':
      return 'Draft';
    case 'closed':
      return 'Closed';
  }
};

const formatCheckedAt = (fetchedAt: number | null): string => (
  fetchedAt ? ` (checked ${new Date(fetchedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })})` : ''
);

/** The status of the branch the worktree has checked out; the scheduler's last known one after a failure. */
const checkedOutBranch = (record: WorktreeStatusRecord | undefined): string | null => {
  if (!record) return null;
  const ready = record.kind === 'ready' ? record : record.lastKnown;
  const current = ready?.status?.current?.trim();
  return current && current !== 'HEAD' ? current : null;
};

const Pill: React.FC<{ pill: WorktreePill; fetchedAt: number | null; error: string | null }> = ({ pill, fetchedAt, error }) => {
  switch (pill.kind) {
    case 'attention': {
      const label = ATTENTION_LABEL[pill.reason];
      return (
        <span role="img" aria-label={label} title={label} className="inline-flex items-center text-[var(--status-error)]">
          <Icon name="alert" className="size-3" />
        </span>
      );
    }
    case 'dirty': {
      const label = pill.count === 1 ? '1 changed file' : `${pill.count} changed files`;
      return <span aria-label={label} title={label} className="text-[var(--status-warning)]">{`●${pill.count}`}</span>;
    }
    case 'clean':
      // An icon, not the ✓ glyph: the interface monospace font has no check mark.
      return (
        <span role="img" aria-label="All committed" title="All committed" className="inline-flex items-center text-muted-foreground/85">
          <Icon name="check" className="size-3" />
        </span>
      );
    case 'ahead': {
      const label = `${pill.count} ${pill.count === 1 ? 'commit' : 'commits'} to push${formatCheckedAt(fetchedAt)}`;
      return <span aria-label={label} title={label}>{`↑${pill.count}`}</span>;
    }
    case 'behind': {
      const label = `${pill.count} ${pill.count === 1 ? 'commit' : 'commits'} to pull${formatCheckedAt(fetchedAt)}`;
      return <span aria-label={label} title={label}>{`↓${pill.count}`}</span>;
    }
    case 'no-upstream':
      return (
        <span role="img" aria-label="No upstream branch" title="No upstream branch" className="inline-flex items-center">
          <Icon name="cloud-off" className="size-3" />
        </span>
      );
    case 'unknown': {
      const label = error ? `Git status unavailable: ${error}` : 'Git status unavailable';
      return (
        <span role="img" aria-label={label} title={label} className="inline-flex items-center">
          <Icon name="question" className="size-3" />
        </span>
      );
    }
    case 'pull-request': {
      const label = `Pull request #${pill.number}, ${pullRequestStatusLabel({ visualState: pill.state, number: pill.number })}`;
      return (
        <span aria-label={label} title={label} className="inline-flex items-center gap-0.5" style={{ color: `var(--pr-${pill.state})` }}>
          <Icon name="git-pull-request" className="size-3" />
          {`#${pill.number}`}
        </span>
      );
    }
  }
};

type Props = {
  directory: string;
  /** The branch the worktree list reported; the light status fills in when it is missing (the root checkout). */
  branch: string | null;
  record: WorktreeStatusRecord | undefined;
  className?: string;
};

/**
 * Git pills of one worktree row (decision D4 of #95). Each rendered worktree
 * keeps its pull request status loaded, so this is the only sidebar place that
 * asks for pull requests.
 */
export const WorktreeGitPills: React.FC<Props> = React.memo(({ directory, branch, record, className }) => {
  const resolvedBranch = branch?.trim() || checkedOutBranch(record);
  useEnsureGitHubPrStatus(directory, resolvedBranch);
  const prKey = React.useMemo(() => getGitHubPrStatusKey(directory, resolvedBranch), [directory, resolvedBranch]);
  const pr = usePrVisualSummary(prKey || null);
  const { pills, fetchedAt, error } = React.useMemo(() => buildWorktreePills(record, pr), [pr, record]);
  if (pills.length === 0) return null;
  return (
    <span className={cn('flex shrink-0 items-center gap-1 typography-micro tabular-nums text-muted-foreground', className)}>
      {pills.map((pill) => <Pill key={pill.kind} pill={pill} fetchedAt={fetchedAt} error={error} />)}
    </span>
  );
});
WorktreeGitPills.displayName = 'WorktreeGitPills';

/** The rollup a collapsed project shows instead of its worktrees' pills. */
export const ProjectDirtyPill: React.FC<{ dirty: number; unknown: number }> = ({ dirty, unknown }) => {
  if (dirty === 0 && unknown === 0) return null;
  const label = [
    dirty > 0 ? `${dirty} ${dirty === 1 ? 'worktree has' : 'worktrees have'} uncommitted changes` : null,
    unknown > 0 ? `${unknown} unknown` : null,
  ].filter(Boolean).join(', ');
  return (
    <span aria-label={label} title={label} className="shrink-0 typography-micro tabular-nums text-[var(--status-warning)]">
      {dirty > 0 ? `${dirty} dirty` : null}
      {unknown > 0 ? <span className="text-muted-foreground">{dirty > 0 ? ' ?' : '?'}</span> : null}
    </span>
  );
};
