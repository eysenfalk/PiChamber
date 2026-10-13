# Slice 3. Wakes and watchdog

Closes #117, part of #116. Depends on slice 2. Proposed role: `task-hard`. Size: 400 to 550 lines. Replaces the old slices 3 (event bus) and 4 (watchdog and lab proof base).

## Owner problem

The orchestrator only learns that a worker finished, asked, failed or got stuck by checking, which costs turns and tokens, and a stuck worker is noticed late.

## Contract

The daemon wakes an idle orchestrator with one short message when one of its workers finishes a run, asks a question, fails or stalls. Several events in a burst arrive as one message; events that arrive while the orchestrator is busy arrive after its run.

## API seam

`orchestration/wakes.js`, in memory:

```js
{ sessionId, kind: 'run_finished' | 'run_failed' | 'question' | 'stalled', reason /* one line, max 200 */, at }
```

- `emit(event)` appends to a queue keyed by the worker's `sessionId`. The owner is looked up in the registry when the batch is sent, not when the event is made, so a takeover in between simply delivers to the new owner.
- Delivery: when the owner is idle, after `coalesceMs` (3 s); when it is busy, at its next settle. One `sendCustomMessage` with `customType: 'pichamber.orchestration.events'`, `display: true`, content one line per event plus "read `orchestration_digest`", `{ triggerTurn: true, deliverAs: 'followUp' }`. The queue entries are removed only after the send resolved; events emitted during the send stay for the next message.
- A dormant owner is reopened through the lease path #107 uses; `SESSION_IN_USE` keeps the queue for the next tick.
- The watchdog lives in the same module, fed by `onSessionSettled`, message and tool events, report calls and extension dialogs, plus one 15 s tick over registered workers:
  - `run_finished`: settle without error.
  - `run_failed`: settle with an error after Pi's retries; `willRetry` is no failure. The reason carries the provider's error line, so the orchestrator can decide on `session_rewind` (slice 4).
  - `question`: a `question` or `blocked` report, or an extension dialog opened in the worker.
  - `stalled`: busy without message, tool update or report for 10 minutes; one event per episode.
- #107's `pichamber.orchestration.result` message and its delivery go away; `RESULT_MESSAGE` stays exported so old transcripts still render.
- `instructions.js`: after a daemon restart or a compaction, read `orchestration_digest` once, because queued wakes are not kept.

Settings (O16): `orchestration.wakes.coalesceMs` (0 to 60 000), `orchestration.watchdog.stallAfterMs` (60 000 to 7 200 000), `orchestration.watchdog.enabled` (default on).

## What the owner sees

Daemon e2e with the faux provider #107 already uses (`orchestration.e2e.test.js`): an idle orchestrator is woken once each by a worker that finishes, one that asks through `worker_report`, one that fails and one that stalls (fake clock); a burst of three while the orchestrator is busy arrives as one message after its run; an event emitted during a pending send is delivered in the next message; after a takeover the next wake goes to the new owner. One screenshot of an orchestrator transcript with an events message in the UI, from a session the implementer seeds in the lab.

## Bewusst nicht gebaut

- No persistence of queued events: a wake lost to a daemon restart is covered by reading the digest after restart.
- No batch ids, acknowledgement, owner generation or delivery lock; a rare duplicate wake costs one cheap turn.
- No lab scripted provider, no new lab tours and no lab settings sidecar; the faux provider e2e is the proof.
- No dedicated UI row for the events message; the generic extension card shows it.
- No `remedy_*`, GitHub or cleanup events here; slices 7 and 8 add their kinds when they need them.

## Gates

Focused tests, the faux provider e2e, type check, lint, `bun run test`, the screenshot looked at.

## Stays green

`session_wait` and spawn with `mode: 'wait'`.
