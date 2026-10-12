# Slice 6. GitHub events

Closes #119. Depends on slice 5. Proposed role: `task-medium`.

## Contract

CI results, review comments, merges and closes of the workers' pull requests reach their orchestrator as events through the bus of slice 3. Nobody runs `gh` for this.

## API seam

New `orchestration/github-watch.js`:

- Every 60 s, and only while at least one `active` or `done` worker has a `branch` or `pullRequest`, read for each such worker the pull request of its branch with state, merge state, head SHA, checks rollup and the newest review or comment, through `packages/web/server/lib/github` (same credential resolution as the UI routes).
- Remember the last snapshot per pull request in memory and in the record (`pullRequest.headSha`, `lastChecks`, `lastCommentAt`).
- A pure `mapPullRequestChange(previous, next) → Event[]`:
  - checks rollup turns `SUCCESS` for the current head → `ci_passed`; any failure → `ci_failed` with the failing job names;
  - a new review or comment by someone other than the bot account → `review_comment` with author and first line;
  - state `MERGED` → `pr_merged` with the merged head SHA; `CLOSED` without merge → `pr_closed`.
- Learns the pull request number from a worker's `ready`/`done` report or by branch lookup, and stores it in the record.

A GitHub failure (no credential, rate limit, network) is one `github_unavailable` line in the digest, not an event per poll and not an empty success. A lab-only source can replace the GitHub reader through the daemon's dependency injection; product code has no fake.

Setting: `orchestration.github.enabled` (default on), `intervalMs`.

## What the owner sees

Table tests for `mapPullRequestChange` over recorded `gh` JSON fixtures. Lab recording with the lab source: the orchestrator is woken by `ci_passed` of a worker's pull request.

## Gates

Mapping tests, poller tests with fake clock (only registered pull requests, back off on failure), `bun run test`, lab recording.

## Left to the implementer

Which `lib/github` functions to reuse or add, the fixture set, how the lab source is wired.

## Stays green

The UI's pull request status in the sidebar, which uses the same module.

## Feedback that changes this slice

The module cannot run in the daemon process: the web server polls and passes changes through a daemon IPC op `orchestration.githubChanged`; the mapping stays pure and shared.
