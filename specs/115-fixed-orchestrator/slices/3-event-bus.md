# Slice 3. Event bus

Part of #116. Depends on slice 2. Proposed role: `task-hard`.

## Contract

Every wake of an orchestrator goes through one bus: one message per burst, kept while the orchestrator is busy or the daemon is down, not lost by an emit during a send, not acknowledged by a sender that lost ownership through a takeover. A repeat after a crash is recognisable.

## API seam

Event shape, `orchestration/events.js`, used by every slice:

```js
{
  id,                 // stable per source episode, e.g. `run:<sessionId>:<runStartedAt>:finished`
  at,
  sessionId,          // worker
  kind: 'run_finished' | 'question' | 'run_failed' | 'stalled'      // slice 4
      | 'remedy_applied' | 'remedy_skipped'                          // slice 5
      | 'ci_passed' | 'ci_failed' | 'review_comment' | 'pr_merged' | 'pr_closed'  // slice 7
      | 'start_failed' | 'cleanup_done' | 'cleanup_blocked',        // slices 8, 9
  reason,             // one line, max 200
  read: 'orchestration_digest' | 'session_read' | '<url>',
}
```

Registry part: `pendingEvents: { '<orchestratorId>': { events: [], inflight: { batchId, eventIds, generation, sentAt? } | null } }`.

`orchestration/event-bus.js`:

- `emit(workerSessionId, event)`: one `update` resolves the worker's current owner and appends the event to that owner's `events`, dropping a duplicate `id` already in `events` or `inflight`.
- Delivery runs when the owner is idle after `coalesceMs` (default 3 s), or at the owner's next settle when it is busy. One `update` claims a batch: all current `events` move into `inflight` with a new `batchId` and the owner's current `generation`.
- Send: one `sendCustomMessage` with `customType: 'pichamber.orchestration.events'`, `display: true`, `details: { batchId, events }`, content one line per event, `{ triggerTurn: true, deliverAs: 'followUp' }`.
- Acknowledge: one `update` clears `inflight` only if its `batchId` and `generation` still match. Events emitted during the send stay in `events` for the next batch.
- Unclear outcome (send threw after starting, or the daemon restarted with an `inflight` batch): before sending again, look for a custom message with that `batchId` in the owner's session entries. Found: acknowledge. Not found: send again with the same `batchId`. A repeat therefore carries the same id, and the content says so.
- A disposed owner is reopened through the lease path as in #107; `SESSION_IN_USE` keeps the batch and retries on the next tick.

Takeover (slice 1's tool) also moves `events` and `inflight` to the new owner and bumps the generation; the old sender's acknowledgement then fails the generation check and the batch is sent to the new owner.

The `pichamber.orchestration.result` message and its `onSessionSettled` delivery are removed; `RESULT_MESSAGE` stays exported for rendering old transcripts. Until slice 4, `run_finished` and `run_failed` are emitted from `onSessionSettled` directly.

Settings (O16): `orchestration.events.coalesceMs`, bounds 0 to 60 000.

## What the owner sees

Tests with fake clock and an injected send: dedup; coalescing; busy delivery after settle; an emit while `sendCustomMessage` is pending lands in the next batch; a crash after the send and before the acknowledgement does not send again when the batch id is in the session, and sends once more when it is not; restart with pending events; `SESSION_IN_USE`; takeover during a pending send moves the batch and the old acknowledgement is ignored. The lab proof comes with slice 4.

## Gates

Focused tests, daemon e2e with the faux provider, type check, lint, `bun run test`.

## Left to the implementer

How the events message reads in the transcript, the batch id format, how the session entries are searched (bounded to the newest entries).

## Stays green

`session_wait` and spawn with `mode: 'wait'`.

## Feedback that changes this slice

Wakes are too frequent for the owner: raise `coalesceMs` here.
