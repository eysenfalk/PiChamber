# Slice 7. Start and cleanup

Closes #118. Depends on slice 6 and on #110 (PR #112) merged. Proposed role: `task-extreme`.

## Contract

One call starts a worker for an issue: branch from `origin/dev` named after the issue, worktree, session with the role's model and thinking, brief. After its pull request is merged the worktree, branch and session are removed, unless the owner switched that off. Nothing is removed for an unmerged pull request, and a failure in the middle leaves a visible, recoverable state.

## API seam

New orchestrator-only tools:

```js
worker_start { issue: number, slug: string, role, brief, repo?: absolute path, clientRequestId }
  → { sessionId, branch, worktree, state }
worker_cleanup { sessionId, force?: false }   // runs the cleanup checks now
worker_abandon { sessionId }                  // undoes a start_failed start
```

`worker_start` steps, each recorded in `record.start.steps` before the next begins:

1. Registry record in `starting` with the intent (issue, branch `<issue>-<slug>`, worktree path, role).
2. `git fetch origin dev`, `git worktree add -b <branch> <path> origin/dev` through the existing git helpers (non-interactive env), refused when the branch or path exists and is not this start's.
3. Gate check of slice 5, then the session through the #107 spawn path with the role's model and thinking and the brief, which tells the worker to open the draft pull request per `docs/workflow.md`.
4. State `active`.

A failure stops, sets `start_failed` with the error and the completed steps, and emits `start_failed`. A retry with the same `clientRequestId` resumes after the last completed step; `worker_abandon` removes only artifacts this start recorded.

Cleanup on `pr_merged` (and by `worker_cleanup`), when `orchestration.cleanup.auto` is on (default on): checks from #112: pull request `MERGED`, local branch tip equals the merged head SHA, worktree clean, no running run. Then stop the session, delete the session (daemon delete op, the same as the UI's), `git worktree remove` (never `--force`), `git branch -d` after the squash check, delete the remote branch. Each step is recorded; a failed check or step sets `cleanup_blocked`, emits `cleanup_blocked` with the reason and leaves everything else; success sets `removed` and emits `cleanup_done`. Never touches `main`, `dev` or a branch with commits not in the merged head.

The skill drops its manual branch, worktree and cleanup steps in favour of these tools.

## What the owner sees

Tests with a temporary git repository and a local bare remote: start, start with failure after each step and resume, abandon, cleanup after a merge, refusal for an unmerged or moved branch. Lab recording: an orchestrator starts a worker for an issue in one call, and after a simulated merge the cleanup removes worktree, branch and session.

## Gates

Focused tests, `bun run test`, lab recording; this slice is a candidate to split into start and cleanup if it passes about 700 review lines.

## Left to the implementer

The worktree location (next to the repository like `~/.wt/worktrees/<repo>/<branch>`, or a setting), how the session delete op is reached from the service, branch slug rules.

## Stays green

`session_spawn` for work that is not tied to an issue.

## Feedback that changes this slice

The owner wants cleanup off by default, or a confirmation per worker: flip the default here.
