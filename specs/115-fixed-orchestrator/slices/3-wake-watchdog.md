# Slice 3. Wake events and watchdog

Part of #116. Depends on slice 2. Proposed role: `task-hard`.

## Contract

An orchestrator is woken by one short message per burst when one of its workers finishes a run, asks a question, ends a run with an error or makes no progress for a configured time. Events are kept while the orchestrator is busy and across a daemon restart, and a burst arrives as one delivery. Detection is in the daemon, never the orchestrator polling.

## API seam

Event, the one shape all slices emit (`orchestration/events.js`):

```js
{
  id,                 // `${source}:${sessionOrPr}:${kind}:${episode}`, dedup key
  at: epochMs,
  sessionId,          // worker
  kind: 'run_finished' | 'question' | 'run_failed' | 'stalled'
      | 'remedy_applied'                                      // slice 4
      | 'ci_passed' | 'ci_failed' | 'review_comment' | 'pr_merged' | 'pr_closed'  // slice 6
      | 'cleanup_done' | 'cleanup_blocked' | 'start_failed', // slice 7
  reason: string,     // one line, max 200
  read: 'orchestration_digest' | 'session_read' | '<url>',
}
```

New `orchestration/event-bus.js`: `emit(orchestratorId, event)` appends to `pendingEvents` in the registry (dedup by `id`), then delivers when the orchestrator is idle after a coalescing window (setting, default 3 s), or on the orchestrator's next settle when it is busy. Delivery is one `sendCustomMessage` with `customType: 'pichamber.orchestration.events'`, `display: true`, `details: { events }`, content one line per event, `{ triggerTurn: true, deliverAs: 'followUp' }`; the pending list is cleared only after the send resolved. A disposed orchestrator is reopened through the lease path as in #107; `SESSION_IN_USE` keeps the events pending and retries on the next tick.

New `orchestration/watchdog.js`, fed by the daemon (`onSessionSettled`, `agent_start`, message and tool events, extension dialog open, `onInputAccepted`), plus one 15 s tick:

- `run_finished`: settle without error of a registered worker.
- `run_failed`: settle with error after Pi's retries are exhausted (a `willRetry` is not a failure).
- `question`: a `question` or `blocked` report, or an extension dialog opened in the worker.
- `stalled`: busy without any message, tool update or report for `stallAfterMs` (default 10 minutes). One event per stall episode; progress ends the episode.

The `pichamber.orchestration.result` message and its `onSessionSettled` delivery are removed; `RESULT_MESSAGE` stays exported for rendering old transcripts.

Settings under `orchestration.watchdog`: `enabled` (default on), `stallAfterMs`, `coalesceMs`.

## What the owner sees

Lab recording with the scripted provider: an idle orchestrator is woken by four workers, one finishing, one asking, one failing, one stalling (lab setting `stallAfterMs` 20 s), each within a minute; then a burst of three events while the orchestrator is busy arrives as one message after its run. The message renders through the extension message card of #107.

## Gates

Unit tests for the bus (dedup, coalescing, busy delivery, restart with pending events, `SESSION_IN_USE`) and every watchdog rule with a fake clock; daemon e2e with the faux provider; type check, lint, `bun run test`; lab recording through `lab/run`.

## Left to the implementer

The tick implementation, how the events message reads in the transcript, the event `id` format beyond being stable per episode.

## Stays green

`session_wait` and spawn with `mode: 'wait'`.

## Feedback that changes this slice

The owner finds the wakes too frequent: raise `coalesceMs` or drop `run_finished` for workers that sent `progress` reports, here.
