# Slice 2. Worker reports and digest

Part of #117 (closed by slice 4 with its lab proof). Depends on slice 1. Proposed role: `task-hard`.

## Contract

Workers report through a tool instead of free text, and one call gives the orchestrator the state of all its workers, a small fraction of their transcripts, without activating dormant runtimes. Unknown values are `null`, not zero.

## API seam

New tool, worker only (policy of slice 1):

```js
worker_report {
  kind: 'progress' | 'question' | 'blocked' | 'ready' | 'done',
  summary: string,                 // one line, max 300
  audience?: 'orchestrator' | 'owner',   // question, blocked
  resolves?: string,               // question id this report settles
  pullRequest?: number,
  noPullRequest?: string,          // reason, for done without a pull request
  evidence?: string[],             // max 10, each max 500
  clientRequestId?,
}
```

Validation by kind: `done` needs `evidence` with at least one item and either `pullRequest` or `noPullRequest`; `ready` needs `pullRequest`; `question` and `blocked` need `audience`. A rejected report changes nothing.

`question` and `blocked` create `question: { id, kind, audience, summary, at }` in the record. It closes only through a matching `resolves`: a worker report with `resolves: '<id>'`, or `session_send { ..., resolves: '<id>' }` from the orchestrator (new optional field). Any other report, a UI prompt from the owner or an unrelated `session_send` leave it open; the digest shows `lastInputAt` so the orchestrator sees that someone wrote. A worker has at most one open question: a new `question` or `blocked` while one is open is refused with `ORCHESTRATION_QUESTION_OPEN`, unless it names the open one in `resolves`, which then replaces it.

`done` stores the report; the worker becomes `done` when the run that made the report settles, so its slot stays taken while that run may still call tools (slice 1). `ready` and `done` store `pullRequest` with the repository of the worker's cwd.

Snapshot at every settle of a registered worker, written by the service: `snapshot: { at, lastProgressAt, lastError: { message, at } | null, usage: { input, output, cacheRead, cacheWrite, cost } }`. `usage` is the session total at that settle, computed from the runtime that just settled.

New tool, orchestrator only:

```js
orchestration_digest { sessionIds?: string[] } → {
  at,
  limit: { workerLimit, used },
  operations: [{ opId, kind, state, step, error, since, remains? }],   // `reserved`, `failed`, and `abandoned` ones with `remains: { branch?, worktree?, sessionId? }` (slice 8) until those are removed after a merge
  workers: [{
    sessionId, title, role, issue, branch, worktree, pullRequest,
    lifecycle, lifecycleSince,            // registry state ('starting', 'active', 'done', ...) and since
    live, liveSince,                      // 'busy' | 'retry' | 'waiting_input' | 'idle' | 'dormant', null if unknown
    lastProgressAt,                       // live when resident, else snapshot; null if never seen
    lastInputAt,
    report: { kind, summary, at, pullRequest?, evidence? } | null,
    question: { id, audience, summary, at } | null,
    lastError: { message, at } | null,
    usage: { settled, settledAt, currentRun } | null,  // currentRun only while busy, from the live run's messages
  }],
}
```

`live` comes from the owners named in the README: the runtime registry (busy, idle, dormant), the retry state map (retry) and the extension bridge's pending dialogs (waiting_input). `session_read` stays for the rare full look.

The worker preamble (slice 1) tells workers to report through `worker_report`; `instructions.js` and the skill tell the orchestrator to read the digest.

## What the owner sees

Tests: four faux workers with long transcripts, the digest's JSON under 10 % of their combined `session_read` output; `done` without evidence refused; an unrelated `session_send`, a UI prompt and a progress report leave the question open, a second question is refused, a report or `session_send` with the matching `resolves` closes it; a `done` report keeps the worker `active` until its run settles; digest after disposal and after a daemon restart shows snapshot values with their time and `live: 'dormant'` without activating a runtime; a retry shows `live: 'retry'`; an open dialog shows `waiting_input`; usage during a run is `settled` plus `currentRun` without double counting after the settle.

## Gates

Focused tests above, type check, lint, `bun run test`.

## Left to the implementer

How `lastError` is cut, how `currentRun` is read from the live session, the exact usage fields Pi provides.

## Stays green

#107 result delivery; it is replaced in slice 3.

## Feedback that changes this slice

The orchestrator still reads transcripts after this slice: add the missing field here.
