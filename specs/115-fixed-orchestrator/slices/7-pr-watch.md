# Slice 7. Pull request watch

Closes #119. Depends on slices 3 and 5. Proposed role: `task-medium`. Size: 200 to 300 lines. Replaces the old slice 7 (GitHub events).

## Owner problem

The orchestrator learns about CI results, review activity and merges of its workers' pull requests through `gh` calls with long output, or not at all.

## Contract

When a worker's pull request gets a final CI result for its head, new comments, a merge or a close, the orchestrator is woken through slice 3.

## API seam

`orchestration/pr-watch.js` in the daemon, every 60 s while at least one registered worker has a `pullRequest` (slice 2). Per pull request it reads state, head and combined check result through `packages/web/server/lib/github` and keeps the last seen `{ headSha, checks, state, comments }` in memory. New kinds for slice 3: `ci_passed`, `ci_failed`, `review_activity`, `pr_merged`, `pr_closed`.

- `ci_passed` / `ci_failed`: the combined result of the current head became final, once per head.
- `review_activity`: the pull request's comment and review comment counts grew; the reason carries the count and the link.
- `pr_merged`, `pr_closed`: the state changed.
- First read after a daemon start: a final CI result and a merged or closed state are reported, comment counts only remembered. A repeat after restart is accepted.
- A read marked stale or with section errors emits nothing.

Credentials come from the GitHub module's existing source; this code reads and logs no token.

Settings (O16): `orchestration.github.enabled` (default on).

## What the owner sees

Tests of the pure diff over fixtures in the module's normalised shape: green, red, a new head, two new comments, a merge, a stale read, a restart. A test that a `ci_passed` event wakes the orchestrator through slice 3.

## Bewusst nicht gebaut

- No paginated comment reader and no persisted cursor: counts are enough to wake the orchestrator, which then reads the pull request when it needs to.
- No configurable poll interval.
- No GitHub source in the lab and no recording.

## Gates

Focused tests, `bun run test`.

## Feedback that changes this slice

`lib/github` needs an HTTP request context and cannot run in the daemon: the web server polls and passes the reads over a daemon IPC op; the diff stays here.
