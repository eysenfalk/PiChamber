# Slice 4. Watchdog and lab proof base

Closes #117, part of #116. Depends on slice 3. Proposed role: `task-hard`.

## Contract

The daemon detects that a registered worker finished, asked, failed or stalled, and emits one event per occurrence to the bus. The lab gets the fixtures every later recording needs.

## API seam

`orchestration/watchdog.js`, fed by the daemon (`onSessionSettled`, `agent_start`, message and tool events, extension dialog open, report calls, input accepted) plus one 15 s tick over registered workers:

- `run_finished`: settle without error.
- `run_failed`: settle with an error after Pi's retries are exhausted; `willRetry` is not a failure.
- `question`: a `question` or `blocked` report, or an extension dialog opened in the worker.
- `stalled`: busy without message, tool update or report for `stallAfterMs` (default 10 minutes). One event per episode; progress ends the episode.

Settings (O16): `orchestration.watchdog.enabled` (default on), `stallAfterMs` (bounds 60 000 to 7 200 000).

Lab proof base, used by slices 4 to 10:

- A lab-only scripted provider for the lab server, wired the way the lab already injects its fixtures (`scripts/lab/start.mjs`), never in product code. #107 has a faux provider only in tests.
- Seed (`scripts/lab/seed.mjs`, `lab/seed-manifest.json`): one project with a local bare remote under `/lab` that has a `dev` branch, so `origin/dev` exists for slice 8.
- Lab settings sidecar with `orchestration.gate.minAvailableBytes` low enough for the 4 GiB lab server, so recordings are deterministic; the real default is covered by unit tests in slice 6.
- Tours under `scripts/proof/` registered in the `lab/run record` allowlist, checked by `lab-rules.test.mjs`.

## What the owner sees

Rules tested with a fake clock. Lab recording `orchestrator-wake`: an idle orchestrator is woken by four workers, one finishing, one asking through `worker_report`, one failing, one stalling (lab `stallAfterMs` 60 s); a burst of three events while it is busy arrives as one message after its run; the orchestrator reads only the digest. This recording closes #117.

## Gates

Watchdog tests, `lab-rules.test.mjs`, type check, lint, `bun run test`, the recording through `lab/run`, watched completely.

## Left to the implementer

The tick implementation, how the scripted provider is scripted per tour.

## Stays green

The existing lab tours and seed manifest checks.

## Feedback that changes this slice

The lab cannot host a scripted provider without product code changes: stop and bring the question to the orchestrator before adding a product seam.
