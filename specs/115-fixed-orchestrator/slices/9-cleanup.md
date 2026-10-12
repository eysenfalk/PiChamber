# Slice 9. Cleanup and delete

Closes #118. Depends on slices 7 and 8. Proposed role: `task-extreme`.

## Contract

After a squash merge, cleanup removes the worker's worktree, branches and session without losing unmerged work. Every removal, automatic or by hand, goes through one guard. A refused or half done cleanup is visible and resumable.

## API seam

`orchestration/cleanup-guard.js`, pure decision over facts the caller gathers:

```js
canRemove({ worker, pr, prLookup, localTip, remoteRef, worktreeClean, hasLiveRun, commitsBeyondDev })
// remoteRef: { state: 'present', tip } | { state: 'absent' } | { state: 'unknown', error }
// prLookup: fresh findPullForBranch result | { error }
  → { ok: true } | { ok: false, reason }
```

- With a registered pull request: identity (repo, number) matches the record, state `merged` from a fresh read (slice 7 rules), `mergedSha` recorded, local tip equal to the pull request's head at merge, the remote ref either `present` with that tip or `absent` (deleted after the merge, as GitHub does by setting), clean worktree, no live run. A remote ref `unknown` blocks (R2-S7).
- Without a registered pull request the state is unknown, not absent (R2-B3). Proof of no pull request is either a remote ref `absent` (slice 8's rule) or a fresh `findPullForBranch` (`lib/github/pulls.js`) for the repository and the head branch. An open pull request refuses and is recorded on the worker for the orchestrator; a merged one is handled by the rules above; a closed unmerged one or none allows removal only with no commits beyond `origin/dev`, clean worktree and no live run. A lookup error, a stale result or a missing credential refuses: no proof, no removal (fail closed, orchestrator decision 2026-10-12).
- Never `main` or `dev`, never another orchestrator's worker.

`orchestration/cleanup.js`, triggered by `pr_merged` when `orchestration.cleanup.auto` is on (default on), or by `worker_cleanup { sessionId }`. It moves the worker to `cleanup_pending` and journals `cleanup: { steps, blockedReason? }`:

1. `git worktree remove <path>`, never `--force`.
2. `git branch -D <branch>`, allowed only because the guard proved the tip equals the merged head; `-d` refuses after a squash.
3. `git push origin --delete <branch> --force-with-lease=<branch>:<headSha>`, skipped when the guard saw the remote ref `absent`.
4. The session through the daemon's `deleteSession`, last, so the record and transcript remain while anything above can fail.

Each step is safe to run again. A refused guard or a failed step sets `cleanup_blocked` with the reason and emits `cleanup_blocked`; success sets `removed` and emits `cleanup_done`.

`session_delete { sessionId }`, orchestrator only, ownership required: deletes a worker without branch or worktree, or one whose cleanup steps 1 to 3 are done; otherwise refused with the guard's reason. `worker_abandon` from slice 8 gains the GitHub lookup here, so a pushed branch without a pull request can be removed too.

## What the owner sees

Tests with a temp repository, a bare remote and squash merges: normal cleanup; a commit after the merge; a dirty worktree; a moved remote branch (lease refusal); a failure after each step and a resume; a live run; a foreign worker; `session_delete` for a worker with unmerged commits refused; a merged pull request whose remote branch GitHub already deleted (cleanup completes, step 3 skipped); an `ls-remote` failure (blocked); a pushed branch without extra commits and an open, unreported draft pull request (abandon and `session_delete` refused, pull request recorded); the same with a failing GitHub lookup (refused). Lab recording: a worker's pull request is merged by squash, the orchestrator receives `pr_merged` and then `cleanup_done`, the worktree and branches are gone.

## Gates

Guard and cleanup tests, `bun run test`, the recording.

## Left to the implementer

Where the git calls live, the journal's step names.

## Stays green

`DELETE /api/pi/sessions/:id` from the UI.

## Feedback that changes this slice

The owner wants automatic cleanup off by default: change the default here.
