# Slice 8. Cleanup and close out

Closes #118 and #115. Depends on slices 4, 6 and 7. Proposed role: `task-hard`. Size: 300 to 450 lines plus the moved documentation. Replaces the old slices 9 (cleanup and delete) and 10 (end to end and close out).

## Owner problem

After a merge, worktrees, branches and worker sessions pile up unless someone removes them by hand, and removing them by hand risks unmerged work.

## Contract

After `pr_merged`, the orchestrator removes a worker's worktree, branches and session with one call. Owner rule (R3-B1): only a proven merge allows removal, and the only proof is a pull request with `mergedAt` set for exactly this head branch. Anything else removes nothing and returns the reason.

## API seam

New tool, orchestrator only, ownership required:

```js
worker_cleanup { sessionId } → { removed: [...], reason? }
```

Guard (`orchestration/cleanup-guard.js`, pure): `findPullForBranch` from `lib/github/pulls.js`, uncached, for the worker's branch in the worker's repository.

- It finds an open pull request: refuse.
- It finds a closed one with `mergedAt` set whose `headSha` equals the local branch tip, the worktree is clean and no run is live: ok.
- Everything else refuses: no pull request, closed without merge, a tip after the merge, a dirty worktree, a live run, a lookup error or missing credential. Never `main` or `dev`.

Steps after ok, each safe to repeat by calling the tool again:

1. `git worktree remove <path>`, never `--force`.
2. `git branch -D <branch>`; `-d` refuses after a squash, the guard proved the tip.
3. `git push origin --delete <branch> --force-with-lease=<branch>:<headSha>`, skipped when the remote branch is already gone.
4. The session through the daemon's `deleteSession`, last.

Helper sessions without a branch (`review`, `research`, `oracle`): `session_spawn` gets an optional `servesPr: { repo, number }`, stored on the worker record. `worker_cleanup` on such a helper deletes its session when that pull request has `mergedAt` set and no run is live; an unbound helper is refused and stays for the owner.

The skill and `instructions.js`: on `pr_merged`, call `worker_cleanup`; on `pr_closed`, ask the owner.

Close out in the same pull request: move what lasts (registry, wakes, policy, guard) into `packages/web/server/lib/pi/session-daemon/DOCUMENTATION.md`, the lab holder rule into `lab/README.md`, the orchestrator's rules into the `orchestrator` skill, the decisions that still hold into a decision record in `docs/adr/`, and delete `specs/115-fixed-orchestrator/`.

## What the owner sees

Tests with a temp repository, a bare remote, squash merges and a fake GitHub client: normal cleanup; a commit after the merge; a dirty worktree; an open pull request; a closed unmerged one; none; a lookup error; a remote branch already deleted; a failure after each step, then the call again; a helper bound to a merged pull request, to an open one, and an unbound helper.

## Bewusst nicht gebaut

- No automatic cleanup on `pr_merged`: the orchestrator calls the tool, and not calling it is the owner's off switch.
- No cleanup journal and no `cleanup_pending` or `cleanup_blocked` states: the steps are safe to repeat and the tool returns the reason.
- No separate `session_delete` tool; `worker_cleanup` covers workers and bound helpers.
- No search over all closed pull requests of a branch: when the latest closed one is unmerged, cleanup refuses, even if an older one was merged.
- No end to end recording: each slice proves its own part.

## Gates

Focused tests, `bun run test:repo`, `bun run test`.

## Stays green

`DELETE /api/pi/sessions/:id` from the UI.
