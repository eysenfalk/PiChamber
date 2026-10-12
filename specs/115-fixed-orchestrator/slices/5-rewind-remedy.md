# Slice 5. Rewind and safe remedy

Closes #116 only if the reproduction proves a safe case; otherwise part of #116. Depends on slice 4. Proposed role: `task-hard`, with the `debug` skill for the first step.

## Contract

The orchestrator can rewind one of its workers to an earlier entry. The daemon repairs the known provider 400 automatically only where a rewind cannot repeat work; every other match is reported with what the orchestrator can do.

## API seam

First step, before code: reproduce `400 invalid_request_error: messages.N.content.0.tool_result: all content must be type text if is_error is true` with a faux provider history. Cover: one read-only tool call returning an image with `isError`; several tool calls in one message where an earlier one edited a file or ran a command; the same failure after a daemon restart. Record in `CONTEXT.md` which entry carries the image and which entry is the last good one.

Refactor first: the `sessions.navigate` IPC case becomes `navigateSession(sessionId, directory, entryId)`, used by the IPC case and passed to the service. `POST /api/pi/sessions/:id/navigate` behaves the same.

New tool, orchestrator only, ownership required (slice 1 policy):

```js
session_rewind { sessionId, entryId, prompt?: string, clientRequestId? }
  → { sessionId, previousLeafId, newLeafId, prompted }
```

Refused with `ORCHESTRATION_SESSION_BUSY` while the worker runs or has a pending dialog. `session_read` lists recent entry ids.

`orchestration/remedies.js`:

```js
{ id: 'tool-error-image', match(error, branch) → { safe: boolean, failingEntryId, lastGoodEntryId, why } }
```

Safe means: the assistant message whose tool result carries the image has exactly one tool call, that tool is read-only (`read`, `ls`, `grep`, `find`), and the failing request is the first request after that result. Then, once per failing entry: rewind to `lastGoodEntryId`, which keeps every earlier completed tool result, and prompt with a short note that reading that file as an image failed and the worker should continue without it. The original task is not sent again. Emit `remedy_applied`. Not safe, disabled or already tried: emit `remedy_skipped` with `why`, and `run_failed`.

The attempt is stored in the worker record `remedy: { '<failingEntryId>': { at, outcome } }`, so it survives restart and is never repeated for the same entry.

Settings (O16): `orchestration.remedies.<id>`, default on.

## What the owner sees

Tests: safe case replays, rewinds, succeeds, `remedy_applied`; the multi-tool case is skipped with its reason; second failure of the same entry after restart is not retried; `session_rewind` refused for a foreign or busy worker and an unknown entry. Lab recording: a worker hits the scripted error in the safe case, the orchestrator is woken by `remedy_applied`, the worker continues.

## Gates

The reproduction tests, existing navigate and fork route tests, remedy tests, `bun run test`, the recording.

## Left to the implementer

The resume note's wording, how `session_read` shows entry ids.

## Stays green

Slice 4 watchdog tests and the navigate and fork routes.

## Feedback that changes this slice

No safe case exists: ship `session_rewind` and detection, leave #116 open and tell the orchestrator, who asks the owner about #116's remedy criterion. The cause is in Pi or a provider adapter: report it upstream only with approval.
