# Slice 8. End to end and close out

Closes #115. Depends on slice 7. Proposed role: `task-medium`.

## Contract

An orchestrator session following the `orchestrator` skill runs a worker from issue to merged pull request without polling, and the lasting parts of this spec live in their owning documents.

## API seam

No new code contract. The `orchestrator` skill describes the final tool and event set as one flow: `orchestration_digest` to read, `worker_start` to start, events to wake, `worker_report` for workers, `lab_acquire` for the lab, `orchestration_takeover` after a restart. Base instructions say the same in short.

Moves before deletion:

- Registry schema, event shape, single-owner rules and settings into `packages/web/server/lib/pi/session-daemon/DOCUMENTATION.md`.
- A decision record (Proposed) for the registry and the event bus replacing the per-result message and the JSONL bookkeeping of #107.
- Remaining findings into `CONTEXT.md`.
- Delete `specs/115-fixed-orchestrator/`.

## What the owner sees

One lab recording with the scripted provider and the lab GitHub source: the orchestrator starts a worker for an issue, is woken by its question, answers, is woken by `ready`, by `ci_passed` and `pr_merged`, and the cleanup removes the worker; the orchestrator reads only the digest throughout. The recording is watched completely.

## Gates

`bun run test`, `bun run test:repo`, `bun run dead-code`, the recording.

## Left to the implementer

The tour script.

## Stays green

Everything.

## Feedback that changes this slice

The owner runs it for a day and finds a gap: a new issue, not a reopened slice.
