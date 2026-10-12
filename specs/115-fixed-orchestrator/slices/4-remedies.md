# Slice 4. Rewind and remedy for known failures

Closes #116. Depends on slice 3. Proposed role: `task-hard`, with the `debug` skill for the first step.

## Contract

A worker that fails with a known error that has a safe remedy is repaired by the daemon and reported; any other failure is only reported. The orchestrator can rewind one of its workers to an earlier entry of its session tree itself. Remedies can be switched off one by one.

## API seam

First step, before any code: reproduce the 2026-10-12 failure `400 invalid_request_error: messages.55.content.0.tool_result: all content must be type text if is_error is true` with a faux provider history, confirm that it comes from an image in an error tool result, and find the last good entry: the newest entry on the branch before the assistant message whose tool call produced that result. The finding goes into `CONTEXT.md`.

Refactor first: the `sessions.navigate` case in `session-daemon.js` becomes one function `navigateSession(sessionId, directory, entryId)` (alias resolution, `navigateTree`, navigation result), used by the IPC case and passed to the orchestration service as a dependency. Behavior of `POST /api/pi/sessions/:id/navigate` stays the same.

New tool, orchestrator only (`childAllowed: false`), not part of #107:

```js
session_rewind { sessionId, entryId, prompt?: string, clientRequestId? }
  → { sessionId, previousLeafId, newLeafId, prompted: boolean }
```

Only for the caller's registered workers. Refused with `ORCHESTRATION_SESSION_BUSY` while the worker has a live run or a pending dialog. After the navigation, `prompt` (when given) starts a run through the same prompt path as `session_send`. Pi's tree keeps the abandoned branch, so nothing is lost; `session_read` lists recent entry ids so the orchestrator can pick one.

New `orchestration/remedies.js`, a table:

```js
{ id: 'tool-error-image', match: (error, runtime) => boolean, lastGoodEntry: (runtime) => entryId, describe }
```

The watchdog calls it on `run_failed` before emitting. When a remedy matches, is enabled and was not tried for this failure episode: rewind through the same function as `session_rewind` to `lastGoodEntry`, prompt the worker with the last user input plus one line saying that a tool result could not be sent and that it should continue without the image, then emit `remedy_applied` with the remedy id, the entry and the outcome. A second failure of the same kind emits `run_failed` with `remedy exhausted`.

Settings: `orchestration.remedies: { '<id>': boolean }`, all on by default.

## What the owner sees

A daemon test replays the failing history against a faux provider that rejects it the way the real one does, and shows the rewind, the `remedy_applied` event and the next run succeeding. Tests for `session_rewind` cover a foreign session, a busy worker and an unknown entry. Lab recording: a worker hits the scripted error, the orchestrator receives `remedy_applied`, the worker continues.

## Gates

The reproduction test, `navigateSession` tests through the existing navigate route tests, remedy table tests (match, disabled, exhausted), `bun run test`, lab recording.

## Left to the implementer

The exact wording of the resume prompt, how `session_read` shows entry ids, whether the match reads the error text or the offending entry. If the reproduction shows no safe last good entry, ship `session_rewind` and the table empty, with detection only, and say so in the pull request.

## Stays green

All slice 3 watchdog tests and the existing navigate and fork route tests.

## Feedback that changes this slice

The reproduction shows the bug is in Pi or in a provider adapter: file it upstream (with approval) and keep the rewind as the local remedy.
