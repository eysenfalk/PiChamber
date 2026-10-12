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

`orchestration/worker-start.js` uses slice 1's operation, kind `start`, found through `requestKeys` by `(orchestratorId, clientRequestId)`. The first `update` reserves the slot (limit and gate) and records the intent. Each step records itself in `steps` before and after it runs, and each write checks that the operation still belongs to the caller (slice 1):

1. `branch`: `git branch <branchName> origin/dev` in the caller's repository, after `git fetch origin dev`; refused if the branch exists and was not created by this operation.
2. `worktree`: `git worktree add` through `packages/web/server/lib/git/service.js` at the worktree root (setting `orchestration.worktreeRoot`, default next to the caller's worktree), path unique by branch name.
3. `session`, `prompted`, `durable`: slice 1's steps, with cwd = that worktree and the brief with the worker preamble. The worker is `starting` until its JSONL exists; if a restart finds it absent, the operation returns to step `session` and keeps branch, worktree and slot.

A retry with the same key resumes at the first unfinished step; a step whose effect already exists is adopted only if it matches the recorded intent (a session is found by the unique worktree cwd and the operation id in its lineage). A failed step sets the operation `failed`, keeps `error: { step, message, at }` and emits `start_failed` to the operation (`emit({ opId }, ...)`, slice 3), because before step `session` there is no worker to name. The digest lists it under `operations` (slice 2) until it is retried or abandoned.

`worker_abandon { clientRequestId }` removes in reverse order only what `steps` says this operation created, each removal through `cleanup-guard.js`, and releases the reservation. This slice creates the guard with its no pull request rule; slice 9 adds the merged rules. A missing pull request in the registry means unknown, not absent (R2-B3). This slice accepts one proof that no pull request can be open for the branch: `git ls-remote --exit-code origin refs/heads/<branch>` exits 2, so the branch was never pushed or is gone, and a pull request needs its head branch on the remote. The branch is then removed only with no commits beyond `origin/dev` and a clean worktree. A pushed branch, or any other `ls-remote` result, refuses the branch removal with the reason (`ORCHESTRATION_GUARD_UNKNOWN_PR`); the worktree and session follow the same rule, and the worker stays for `worker_cleanup` in slice 9, which can ask GitHub.

## What the owner sees

Tests with a temp git repository and a bare remote: success; failure injected after each step, then retry, gives one branch, one worktree and one session; restart between steps; abandon after each step removes only created artifacts and refuses a branch with commits beyond `origin/dev`; a branch pushed without extra commits and with an open draft pull request that was never reported is refused; an `ls-remote` that fails (unreachable remote) is refused; a failure before step `session` shows `start_failed` to the orchestrator and an entry in the digest's `operations`; a crash after `session` before the first assistant message, then restart and retry, gives one durable session in the same worktree. Lab recording: the orchestrator starts a worker for an issue with one call.

## Gates

Focused tests, `bun run test`, the recording.

## Left to the implementer

Git calls through `lib/git/service.js` or a small helper there, the worktree path scheme.

## Stays green

`session_spawn`, the git service routes.

## Feedback that changes this slice

The slice exceeds 600 lines: split abandon into its own pull request before slice 9.
