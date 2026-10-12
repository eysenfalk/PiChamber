# Slice 9. Cleanup and delete

Closes #118. Depends on slices 7 and 8. Proposed role: `task-extreme`.

## Contract

After a squash merge, cleanup removes the worker's worktree, branches and session without losing unmerged work. Owner rule (2026-10-12, R3-B1): worktree, branch and worker session are removed only after a proven merge, and the only proof is a pull request in state `merged` (`mergedAt` set) for exactly this head branch. A closed unmerged pull request, a missing pull request and a missing remote branch are no proof: nothing is removed, the case is reported. Every removal, automatic or by hand, goes through one guard. A refused or half done cleanup is visible and resumable.

## API seam

`orchestration/cleanup-guard.js`, pure decision over facts the caller gathers:

```js
canRemove({ worker, pulls, localTip, remoteRef, worktreeClean, hasLiveRun })
// pulls: fresh list of pull requests whose head is exactly worker.branch in worker's repository | { error }
// remoteRef: { state: 'present', tip } | { state: 'absent' } | { state: 'unknown', error }
  → { ok: true } | { ok: false, reason }
```

The only `ok` case: `pulls` is a fresh read without error, stale flag or section errors (slice 7 rules), it contains no open pull request, and it contains a pull request with `mergedAt` set whose head repository and head branch are exactly the worker's, which matches the registered `pullRequest` if there is one, and whose head at merge equals the local tip. In addition the remote ref is either `present` with that tip or `absent` (deleted after the merge, as GitHub does by setting; this is accepted only next to the merged pull request, never as proof by itself), the worktree is clean and no run is live. A remote ref `unknown` blocks (R2-S7).

Everything else refuses with a reason the orchestrator can pass on: no pull request for the branch, only closed unmerged ones, an open one, a lookup error or missing credential, a tip after the merge, a dirty worktree, a live run. A pull request missing from the registry is looked up the same way and then recorded on the worker.
Lookup: `findPullForBranch` in `lib/github/pulls.js` asks only for open pull requests. This slice gives it a `state` option; the guard asks with `state: 'all'`, uncached, across all pages, while existing callers keep the default.
- Never `main` or `dev`, never another orchestrator's worker.

`pr_closed` triggers no cleanup: the worker stays, the event and the digest report it, and the orchestrator asks the owner (as the #112 skill says for a pull request closed without merge).

`orchestration/cleanup.js`, triggered by `pr_merged` when `orchestration.cleanup.auto` is on (default on), or by `worker_cleanup { sessionId }`. It moves the worker to `cleanup_pending` and journals `cleanup: { steps, blockedReason? }`:

1. `git worktree remove <path>`, never `--force`.
2. `git branch -D <branch>`, allowed only because the guard proved the tip equals the merged head; `-d` refuses after a squash.
3. `git push origin --delete <branch> --force-with-lease=<branch>:<headSha>`, skipped when the guard saw the remote ref `absent`.
4. The session through the daemon's `deleteSession`, last, so the record and transcript remain while anything above can fail.

Each step is safe to run again. A refused guard or a failed step sets `cleanup_blocked` with the reason and emits `cleanup_blocked`; success sets `removed` and emits `cleanup_done`.

`session_delete { sessionId }`, orchestrator only, ownership required: deletes the session of a worker whose guard said `ok` and whose cleanup steps 1 to 3 are done, the manual form of step 4; otherwise refused with the guard's reason. Helper sessions without a branch of their own (`session_spawn` with role `review`, `research`, `oracle` and the like) can be bound to a pull request at spawn: `session_spawn` gets an optional `servesPr: { repo, number }`, stored unchanged on the worker record and never changed later (not by `session_send`, not by takeover). `session_delete` removes a bound helper when the guard says `ok` for it: a fresh read of exactly that pull request (same repository and number, slice 7 rules) has `mergedAt` set, later than the helper's `createdAt`, and the helper has no live run. A closed unmerged pull request, a lookup error or an unbound helper refuses; an unbound helper is never deleted by the orchestrator and stays `stopped` for the owner. There is no automatic deletion of helpers and no path for closed pull requests.

## What the owner sees

Tests with a temp repository, a bare remote and squash merges: normal cleanup; a commit after the merge; a dirty worktree; a moved remote branch (lease refusal); a failure after each step and a resume; a live run; a foreign worker; `session_delete` for a worker with unmerged commits refused; a merged pull request whose remote branch GitHub already deleted (cleanup completes, step 3 skipped); an `ls-remote` failure (blocked); an unregistered draft closed without merge on a clean branch without extra commits, once with the remote branch present and once absent (nothing removed, reported); no pull request at all with the remote branch absent (nothing removed); an open, unreported draft (refused, pull request recorded); a failing GitHub lookup (refused); `pr_closed` (no cleanup); `session_delete` of an unbound helper (refused); a helper bound to a merged pull request (deleted), to an open or closed unmerged one (refused), to one merged before the helper was created (refused), with a failing lookup (refused), and during a live run (refused); `servesPr` unchanged after takeover. Lab recording: a worker's pull request is merged by squash, the orchestrator receives `pr_merged` and then `cleanup_done`, the worktree and branches are gone.

## Gates

Guard and cleanup tests, `bun run test`, the recording.

## Left to the implementer

Where the git calls live, the journal's step names.

## Stays green

`DELETE /api/pi/sessions/:id` from the UI.

## Feedback that changes this slice

The owner wants automatic cleanup off by default: change the default here.
