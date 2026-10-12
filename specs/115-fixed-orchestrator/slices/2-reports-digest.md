# Slice 2. Worker reports and digest

Closes #117. Depends on slice 1. Proposed role: `task-medium`.

## Contract

Workers report through a tool instead of free text, and one call gives the orchestrator the state of all its workers in a result that is a small fraction of their transcripts.

## API seam

New tool, worker only (orchestrators get `ORCHESTRATION_FORBIDDEN`):

```js
worker_report {
  kind: 'progress' | 'question' | 'blocked' | 'ready' | 'done',
  summary: string,              // one line, max 300
  audience?: 'orchestrator' | 'owner',   // for question and blocked
  pullRequest?: number,         // ready, done
  evidence?: string[],          // max 10 items, each max 500: commands with results, proof links
  clientRequestId?,
}
```

The service stores the latest report per kind group in the worker's record (`report`, and `openQuestion` for `question` and `blocked`). An open question clears when the worker receives its next input from any source: `session_send`, the owner's prompt in the UI, or a steer. The daemon's prompt and steer path calls one `onInputAccepted(sessionId)` hook for this. `ready` and `done` set `pullRequest` in the record when given.

New tool, orchestrator only:

```js
orchestration_digest { sessionIds?: string[] } → {
  at: epochMs,
  limit: { workerLimit, active },
  workers: [{
    sessionId, title, role, issue, branch, worktree, pullRequest,
    lifecycle,                 // registry state
    live: 'starting' | 'busy' | 'retry' | 'waiting_input' | 'idle' | 'dormant',
    since: epochMs,            // start of the current live state
    lastProgressAt,            // latest assistant message, tool result or report
    report: { kind, summary, at, evidence? },
    openQuestion: { audience, summary, at } | null,
    lastError: { message, at } | null,  // last run's error, first 300 characters
    usage: { input, output, cacheRead, cacheWrite, cost },
  }],
}
```

`usage` is a snapshot the service writes into the record at each settle, so a dormant worker is never activated for the digest. `waiting_input` comes from a pending extension dialog of that session (`extension.dialog`), the same live channel the UI uses.

`session_read` stays for the rare full look. Instructions and the skill tell workers to report through `worker_report`, and the orchestrator to read the digest.

## What the owner sees

A test with four faux workers that each produced a long transcript: the digest's JSON is under 10 % of their combined `session_read` output. A worker's `done` report carries its pull request and evidence. The lab recording comes with slice 3, where the wake points at the digest.

## Gates

Focused tests for the report tool, the open question lifecycle (cleared by `session_send` and by a UI prompt), the digest shape and the size ratio; type check, lint, `bun run test`.

## Left to the implementer

How the summary of `lastError` is cut, the exact usage fields that Pi's assistant messages provide, whether the per-settle usage snapshot is stored as a total or as a sum of deltas.

## Stays green

#107 result delivery still works; it is replaced in slice 3.

## Feedback that changes this slice

The orchestrator still reads transcripts after this slice: the digest misses a field, add it here.
