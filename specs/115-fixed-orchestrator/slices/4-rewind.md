# Slice 4. Rewind

Closes #116. Depends on slice 3. Proposed role: `task-medium`. Size: 150 to 250 lines. Replaces the old slice 5 (rewind and safe remedy).

## Owner problem

A worker whose provider rejects its history (known case: `400 ... tool_result: all content must be type text if is_error is true` after an image in an error tool result) fails on every new message until someone moves it back to the last good entry.

## Contract

The orchestrator, woken by `run_failed` with the error line (slice 3), can rewind one of its workers to an earlier entry and prompt it again, in one call.

## API seam

Refactor first: the inline `sessions.navigate` IPC case becomes `navigateSession(sessionId, directory, entryId)`, used by the IPC case and passed to the service. `POST /api/pi/sessions/:id/navigate` behaves the same.

New tool, orchestrator only, ownership required (slice 1 policy):

```js
session_rewind { sessionId, entryId, prompt?: string }
  → { sessionId, previousLeafId, newLeafId, prompted }
```

Refused with `ORCHESTRATION_SESSION_BUSY` while the worker runs or has an open dialog. `session_read` shows entry ids. The `orchestrator` skill and `instructions.js` name the known 400 and the remedy: rewind to just before the assistant message whose tool result carries the image, then prompt the worker to continue without that file; if that message also edited files or ran commands, ask the worker to check its worktree first.

## What the owner sees

Tests: rewind of an idle worker moves the leaf and keeps the session id; with `prompt` the worker runs again; refused for a foreign worker, a busy worker and an unknown entry. A faux provider e2e that fails with the 400 text, a `run_failed` wake, then `session_rewind` and a successful run.

## Bewusst nicht gebaut

- No automatic remedy and no remedy table: the `run_failed` wake reaches the orchestrator within seconds, and deciding whether a rewind may repeat edits is the judgement the orchestrator is there for.
- No reproduction study in `CONTEXT.md` and no persisted remedy attempts.
- No fork tool (O14).

## Gates

Focused tests, existing navigate and fork route tests, `bun run test`.

## Feedback that changes this slice

The 400 keeps recurring and costs the owner time even with the wake: open an idea issue for an automatic remedy of exactly that case.
