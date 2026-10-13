# Slice 6. Worker start

Part of #118. Depends on slice 2. Proposed role: `task-hard`. Size: 250 to 400 lines. Replaces the old slice 8.

## Owner problem

Starting a worker for an issue is several manual steps for the orchestrator: branch from `origin/dev`, worktree, session with role, brief.

## Contract

One call starts a worker for an issue. Calling it again with the same arguments after a failure continues where it stopped.

## API seam

New tool, orchestrator only:

```js
worker_start { clientRequestId, issue: { repo, number }, role, branchName, brief, model?, thinking? }
  → { sessionId, branch, worktree }
```

`orchestration/worker-start.js`:

1. `git fetch origin dev`, then the branch `branchName` from `origin/dev` in the caller's repository. An existing branch is reused only when its tip is still `origin/dev` or it is checked out in the worktree path below; otherwise refused.
2. The worktree at `<worktreeRoot>/<branchName>` (setting `orchestration.worktreeRoot`, default the parent of the caller's worktree) through `packages/web/server/lib/git/service.js`. An existing worktree at that path on that branch is reused.
3. `session_spawn` from slice 1 with cwd = that worktree, role, model, thinking and the brief, under the same `clientRequestId`, so its reservation, gate and crash recovery apply unchanged. `issue`, `branch` and `worktree` are stored on the worker record; the digest shows them (`issue` is `null` until this slice).

A failure returns the step and git's message as the tool error; nothing is rolled back, and the same call continues.

## What the owner sees

Tests with a temp repository and a bare remote: success; failure after step 1 and after step 2, then the same call, gives one branch, one worktree, one worker; an existing foreign branch is refused; the digest shows issue, branch and worktree. The tool result in the orchestrator transcript is the visible output; no recording.

## Bewusst nicht gebaut

- No step journal, no `start_failed` event and no `operations` entries for branch and worktree: the call is synchronous, so the orchestrator sees the error directly and repeats the call.
- No `worker_abandon`: `session_stop` stops the worker, and branch and worktree stay, as the owner rule wants for anything unmerged.
- No draft pull request: the worker opens it, as the workflow requires.

## Gates

Focused tests, `bun run test`.

## Stays green

`session_spawn` and the git service routes.
