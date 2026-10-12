# Slice 8. Worker start

Part of #118. Depends on slice 6. Proposed role: `task-extreme`.

## Contract

Starting a worker for an issue is one call: branch, worktree, session, brief. A failure leaves a named, resumable record; a retry continues; abandoning stops the work and releases the slot but removes nothing (owner rule, slice 9).

## API seam

New tool, orchestrator only:

```js
worker_start { clientRequestId, issue: { repo, number }, role, branchName, title?, brief, model?, thinking? }
  → { sessionId, branch, worktree, state }
```

`orchestration/worker-start.js` uses slice 1's operation, kind `start`, found through `requestKeys` by `(orchestratorId, clientRequestId)`. The first `update` reserves the slot (limit and gate) and records the intent. Each step records itself in `steps` before and after it runs, and each write checks that the operation still belongs to the caller (slice 1):

1. `branch`: `git branch <branchName> origin/dev` in the caller's repository, after `git fetch origin dev`; refused if the branch exists and was not created by this operation.
2. `worktree`: `git worktree add` through `packages/web/server/lib/git/service.js` at the worktree root (setting `orchestration.worktreeRoot`, default next to the caller's worktree), path unique by branch name.
3. `session`, `prompted`, `durable`: slice 1's steps, with cwd = that worktree and the brief with the worker preamble. The worker is `starting` until its JSONL exists; if a restart finds it absent, the operation returns to step `session` and keeps branch, worktree and slot.

A retry with the same key resumes at the first unfinished step; a step whose effect already exists is adopted only if it matches the recorded intent (a session is found by the unique worktree cwd and the operation id in its lineage). A failed step sets the operation `failed`, keeps `error: { step, message, at }` and emits `start_failed` to the operation (`emit({ opId }, ...)`, slice 3), because before step `session` there is no worker to name. The digest lists it under `operations` (slice 2) until it is retried or abandoned.

`worker_abandon { clientRequestId }` stops a running worker through `session_stop`, sets the operation `abandoned`, the worker (if any) `stopped`, and releases the reservation in the same `update`. It removes no branch, worktree or session: by the owner rule (R3-B1, slice 9) only a proven merge allows removal, and an abandoned start has none. The result and an `abandoned` entry in the digest list what remains (`branch`, `worktree`, `sessionId`), so the orchestrator can tell the owner. A later merge of a pull request from that branch still reaches cleanup through slice 9.

## What the owner sees

Tests with a temp git repository and a bare remote: success; failure injected after each step, then retry, gives one branch, one worktree and one session; restart between steps; abandon after each step releases the slot, removes nothing and lists what remains; abandon of a running worker stops it first; a failure before step `session` shows `start_failed` to the orchestrator and an entry in the digest's `operations`; a crash after `session` before the first assistant message, then restart and retry, gives one durable session in the same worktree. Lab recording: the orchestrator starts a worker for an issue with one call.

## Gates

Focused tests, `bun run test`, the recording.

## Left to the implementer

Git calls through `lib/git/service.js` or a small helper there, the worktree path scheme.

## Stays green

`session_spawn`, the git service routes.

## Feedback that changes this slice

The slice exceeds 600 lines: split abandon into its own pull request before slice 9. The owner allows removing what a start created when it never pushed: add that as a guard rule in slice 9, not here.
