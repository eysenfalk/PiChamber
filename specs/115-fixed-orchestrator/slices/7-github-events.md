# Slice 7. GitHub events

Closes #119. Depends on slice 6, because it closes #119 with slice 6's proofs and so must merge after it (R2-S5). Proposed role: `task-hard`.

## Contract

CI results, review comments, merges and closes of the workers' pull requests reach the orchestrator through the bus. The orchestrator never polls. A stale or partial read is never taken for a change.

## API seam

`orchestration/github-watch.js` in the daemon, every 60 s while at least one registered worker has a `pullRequest` and is not `removed`. It reads through `packages/web/server/lib/github` (pull request detail, checks, reviews and review threads) and stores a cursor per worker:

```js
github: { fetchedAt, headSha, state, checks: { headSha, conclusion },
          comments: { highWater: <createdAt> | null, idsAtOverlap: [] }, mergedSha? }
```

The reader works on the module's normalised values: pull request state `open | closed | merged`, check conclusion `success | failure | pending | unknown`, plus `stale`, `fetchedAt` and `sectionErrors`.

Comments: today's `getPull` reads one page of reviews and a capped number of review threads and thread comments, so it cannot serve as the comment source. This slice adds one paginated reader to `packages/web/server/lib/github/pulls.js`, `listPullActivity(credential, repo, number, { since })`, over the REST lists that accept `since` or are ordered by time (issue comments, review comments, reviews), following every page like the existing page loops in that file, normalised to `{ id, kind, author, createdAt, url }`. It never serves cached or stale data. The watcher asks for activity since `highWater` minus a five minute overlap; an item is new when it is newer than `highWater`, or inside the overlap and its id is not in `idsAtOverlap`. After an event, `highWater` becomes the newest `createdAt` seen and `idsAtOverlap` holds the ids of the last five minutes before it, so the set stays small however long the thread gets. Edits of old comments are not events. Event ids carry repository, number and head, for example `pr:<repo>#<n>:<headSha>:ci_passed`.

Pure mapping `diffPullRequest(cursor, fresh) → { events, cursor }`:

- `ci_passed` / `ci_failed`: the combined conclusion for the current head changed to success or failure. One event per head and conclusion.
- `review_comment`: new items by the rule above, from people and bots alike, one event per poll that lists the count and a link.
- First snapshot (no cursor, also after an upgrade): existing comments count as seen (`highWater` = newest `createdAt`); a final CI conclusion of the current head and a `merged` or `closed` state are emitted, so a merge during daemon downtime still reaches cleanup.
- `pr_merged` with `mergedSha`, `pr_closed`.

Read results with `stale: true` or any `sectionErrors` advance no part of the cursor that depends on the failed section and emit nothing for it; the digest shows `github: { fetchedAt, stale }`. The cursor is written in the same `update` as the emitted events, so a restart neither repeats nor loses one.

Credentials come from the GitHub module's existing credential source; no token is read or logged by this code.

Settings (O16): `orchestration.github.enabled` (default on), `pollMs` (bounds 60 000 to 900 000).

Lab: a lab-only GitHub source in the lab server startup, scripted per tour, the same seam the module's tests use; product code has no fake.

## What the owner sees

Mapping tests from fixtures in the module's normalised shape: a stale read, failed checks of one source with the other `success`, and a fully failed read emit nothing, then the real change once; two comments in one poll; a bot comment after a human one; a new head with checks of the same names; a merge during downtime on the first snapshot; a restart between polls emits nothing twice; 250 unchanged comments over several polls and a restart emit nothing; one new comment among them emits one event; reader tests with a fake client over three pages, and with more than 20 comments in one review thread. Lab data is synthetic only. Lab recording: a worker's pull request turns green, the orchestrator is woken with `ci_passed`. This recording plus slice 6 closes #119.

## Gates

Mapping and watcher tests, `bun run test`, the recording.

## Left to the implementer

Which other `lib/github` functions to call for state and checks, the shape of the lab source.

## Stays green

The GitHub module's routes and caches.

## Feedback that changes this slice

The GitHub module needs a request context in the daemon process: the web server polls and passes the fresh reads over a daemon IPC op; the mapping and cursor stay here. With the reader the slice is estimated at 450 to 600 lines; if it grows beyond that, `listPullActivity` with its tests becomes its own pull request before this one.
