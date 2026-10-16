# 0016. The owner reads and answers orchestration through private daemon commands

- Status: Proposed
- Date: 2026-10-15
- Waits for: the owner's review of PR #194

## Context

Issue #20 asks for one place where the owner sees every orchestrator's workers (state, open questions, pull requests with CI, host load), and #87 for a decision inbox that answers questions across sessions. Until #194 the owner saw this only through an orchestrator's chat: `orchestration_digest` and the wakes ([ADR 0011](0011-fixed-orchestrator.md)) are tools of a marked orchestrator session, scoped to its own workers, and a worker's question closed only when the orchestrator sent `session_send` with `resolves`.

The registry ([ADR 0011](0011-fixed-orchestrator.md)) already holds each worker's lifecycle, last report, open question and pull request watch; the extension bridge holds each resident session's pending dialog. The orchestration tools ([ADR 0010](0010-orchestration-through-daemon-tools.md)) need a calling session, which the owner's browser is not.

Owner decisions on the plan in PR #194 (2026-10-15, quoted by the orchestrator): the control center is a main view and the sidebar gets only a worker filter (Q3); the inbox shows every open worker question, owner audience first, and the owner may answer orchestrator questions too (Q4); a prompt typed in a worker's chat does not close its question, the inbox offers "Mark answered" (Q5); a question may carry a brief (Q6); the merge guard blocks only `main` and is a soft barrier, agent credentials without merge rights follow in #199 (Q7); the view polls every 5 s while visible (Q8); every marked orchestrator's workers are shown, grouped (Q9). Provisional intents stay in #87 until #70 exists.

Alternatives considered: answering through the orchestrator (it would have to relay every owner answer and decide what is the owner's); a session-scoped MCP credential for the browser (the owner is no session, and the credential would grant orchestrator tools); an event stream for the overview (no measured cost that polling cannot carry, Q8).

## Decision

- The owner reads orchestration through the private daemon command `orchestration.overview`, exposed as `GET /api/pi/orchestration/overview`. It takes no caller and returns every marked orchestrator and every session that still owns workers, each worker with the digest fields, the slot use, host numbers and the pending dialogs of resident sessions. It never activates a dormant session, and a failed registry read is an error, never an empty list.
- The owner answers a worker question through `orchestration.answer` (`POST /api/pi/orchestration/questions/:sessionId/:questionId/answer`): the text goes to the worker as the owner's own prompt, and the question closes only after Pi accepted it. `orchestration.resolve` (`…/resolve`) closes it without a prompt. A question that is not open answers `ORCHESTRATION_QUESTION_UNKNOWN` and changes nothing.
- An owner prompt is the owner's: the end of that run wakes no orchestrator (#156, last writer decides).
- Extension dialogs are answered through the existing `extensions.respond` path; there is no second dialog protocol.
- `worker_report` takes an optional `brief` (options, recommendation, strongest counterargument, when to revisit) on `question` and `blocked`; the digest and the overview pass it through unchanged.
- The orchestrator's instructions leave owner questions and dialogs to the owner.
- For every worker and marked orchestrator the daemon blocks tool calls that push to `main` or merge a pull request whose base is `main`; `dev` and every other branch stay allowed.

## Consequences

- The control center and the decision inbox on every runtime (desktop, web, hosted mobile, Capacitor) read one contract through `/api/pi/*`, and the registry stays the only authority; the UI keeps no copy of worker state beyond its polled snapshot.
- Anyone who can reach the authenticated PiChamber server can answer any worker question; that is the owner's existing trust boundary, not a new one.
- The merge guard reads command text only, so a script or alias gets past it; real enforcement needs credentials without merge rights (#199).
- Polling costs one overview read every 5 s per visible control center.

## Revisit when

The overview read shows up in measurements as a cost polling cannot carry, #70 lands provisional intents for the inbox, more than one human answers workers, or #199 replaces the merge guard.
