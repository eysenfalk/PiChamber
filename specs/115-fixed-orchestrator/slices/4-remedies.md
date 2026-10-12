# Slice 4. Remedy for known failures

Closes #116. Depends on slice 3. Proposed role: `task-hard`, with the `debug` skill for the first step.

## Contract

A worker that fails with a known error that has a safe remedy is repaired by the daemon and reported; any other failure is only reported. Remedies can be switched off one by one.

## API seam

First step, before any code: reproduce the 2026-10-12 failure `400 invalid_request_error: messages.55.content.0.tool_result: all content must be type text if is_error is true` with a faux provider history and find which entry Pi sends (a tool result with `isError` and an image or other non text part). The finding goes into `CONTEXT.md`.

New `orchestration/remedies.js`, a table:

```js
{ id: 'tool-error-non-text', match: (error) => boolean, apply: async (ctx) => outcome, describe }
```

The watchdog calls it on `run_failed` before emitting. When a remedy matches, enabled and not yet tried for this episode: apply, emit `remedy_applied` with the remedy id and its outcome, resend the last user input once. A second failure of the same kind emits `run_failed` with `remedy exhausted`.

Candidate remedy, decided by the first step: the orchestration extension's Pi `context` hook rewrites error tool results to text parts before they reach the provider (keeps the history, fixes every later message), or a compaction of the session. The hook is preferred because it does not lose context and applies to every session, not only workers.

Settings: `orchestration.remedies: { '<id>': boolean }`, all on by default.

## What the owner sees

A daemon test replays the failing history against a faux provider that rejects it the way the real one does, and shows the remedy, the `remedy_applied` event and the next run succeeding. Lab recording: a worker hits the scripted error, the orchestrator receives `remedy_applied`, the worker continues.

## Gates

The reproduction test, remedy table tests (match, disabled, exhausted), `bun run test`, lab recording.

## Left to the implementer

The remedy itself, after the reproduction. If no safe remedy exists, ship the table empty with detection and say so in the pull request.

## Stays green

All slice 3 watchdog tests.

## Feedback that changes this slice

The reproduction shows the bug is in Pi or in a provider adapter: file it upstream (with approval), keep the context hook as the local remedy.
