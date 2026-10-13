// The rule of `worker_cleanup` (#118): only a proven merge allows removal,
// and the only proof is a merged pull request for exactly the worker's head
// branch whose head is the local tip. Pure: the caller gathers the facts.

const PROTECTED_BRANCHES = new Set(['main', 'dev']);

/**
 * The reason cleanup is refused, or null when it may run.
 * `helper` is a session without its own branch, bound by `servesPr`; only the
 * merge and the live run decide for it.
 * @param {{ helper?: boolean, branch?: string, pr?: { number: number, state: string,
 *   mergedAt: string | null, headSha: string | null } | null, lookupError?: string,
 *   localTip?: string, clean?: boolean, live: boolean }} facts
 *   `localTip` is undefined when the local branch is already deleted.
 */
export const cleanupRefusal = ({ helper = false, branch, pr, lookupError, localTip, clean = true, live }) => {
  if (!helper) {
    if (!branch) return 'The worker\'s worktree has no branch checked out.';
    if (PROTECTED_BRANCHES.has(branch)) return `${branch} is never cleaned up.`;
  }
  if (lookupError) return `The pull request lookup failed: ${lookupError}`;
  if (!pr) return helper ? 'The pull request this helper serves was not found.' : `No pull request exists for ${branch}.`;
  if (pr.state === 'open') return `PR #${pr.number} is still open.`;
  if (!pr.mergedAt) return `PR #${pr.number} was closed without a merge; ask the owner.`;
  if (!helper && (!pr.headSha || (localTip && localTip !== pr.headSha))) {
    return `${branch} is at ${localTip?.slice(0, 7)}, not at the merged head ${pr.headSha?.slice(0, 7) ?? '(unknown)'} of PR #${pr.number}; its later commits are not merged.`;
  }
  if (!clean) return 'The worktree has uncommitted or untracked changes.';
  if (live) return 'The worker is running or waiting for input; stop it or wait until it is idle.';
  return null;
};
