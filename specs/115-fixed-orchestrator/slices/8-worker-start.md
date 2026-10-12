# Slice 8. Worker start

Part of #118. Depends on slice 6. Proposed role: `task-extreme`.

## Contract

Starting a worker for an issue is one call: branch, worktree, session, brief. A failure leaves a named, resumable record; a retry continues; abandoning removes only what this start created and only through the deletion guard.

## API seam

New tool, orchestrator only:

```js
worker_start { clientRequestId, issue: { repo, number }, role, branchName, title?, brief, model?, thinking? }
  → { sessionId, branch, worktree, state }
```

`orchestration/worker-start.js` uses slice 1's operation, kind `start`, keyed by `(orchestratorId, clientRequestId)`. The first `update` reserves the slot (limit and gate) and records the intent. Each step records itself in `steps` before and after it runs:

1. `branch`: `git branch <branchName> origin/dev` in the caller's repository, after `git fetch origin dev`; refused if the branch exists and was not created by this operation.
2. `worktree`: `git worktree add` through `packages/web/server/lib/git/service.js` at the worktree root (setting `orchestration.worktreeRoot`, default next to the caller's worktree), path unique by branch name.
3. `session`: create the session with cwd = that worktree and the operation id in its lineage entry, the brief with the worker preamble.
4. `registered`: the worker record exists, the operation is `created`.

A retry with the same key resumes at the first unfinished step; a step whose effect already exists is adopted only if it matches the recorded intent (a session is found by the unique worktree cwd and the operation id in its lineage). A failed step sets the operation `failed` and emits `start_failed` with the step and what exists.

`worker_abandon { clientRequestId }` removes in reverse order only what `steps` says this operation created, each removal through `cleanup-guard.js` (slice 9 ships the guard; this slice adds its no pull request rule first), and releases the reservation.

## What the owner sees

Tests with a temp git repository and a bare remote: success; failure injected after each step, then retry, gives one branch, one worktree and one session; restart between steps; abandon after each step removes only created artifacts and refuses a branch with commits beyond `origin/dev`. Lab recording: the orchestrator starts a worker for an issue with one call.

## Gates

Focused tests, `bun run test`, the recording.

## Left to the implementer

Git calls through `lib/git/service.js` or a small helper there, the worktree path scheme.

## Stays green

`session_spawn`, the git service routes.

## Feedback that changes this slice

The slice exceeds 600 lines: split abandon into its own pull request before slice 9.
