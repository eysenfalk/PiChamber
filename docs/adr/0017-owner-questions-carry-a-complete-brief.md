# 0017. Owner questions and blockers carry a complete brief, enforced by the daemon

- Status: Proposed
- Date: 2026-10-15
- Waits for: the owner's review of PR #211

## Context

Since #194 ([ADR 0016](0016-owner-reads-and-answers-orchestration-through-private-daemon-commands.md)) the owner answers worker questions in the decision inbox of the control center. The brief was optional (options as plain strings, recommendation, counterargument, revisit), and workers sent questions the owner could not answer there: several decisions in one report, internal shorthand from the worker's chat (slice and step codes), no word on why the decision was needed or what happens until the answer. The owner, in issue #210 (2026-10-15): "die muessen gut gestellt und mit genuegend kontext versehen sein. ich muss fragen und blocker verstehen koennen, um direkt aus dem center antworten zu koennen."

Prompt text alone does not hold: workers run on different models and briefs, and an incomplete question only shows up when the owner reads it. AGENTS.md asks for correctness to be enforced in core logic, not only in prompts.

Owner decision on the plan in PR #211 (2026-10-15, passed on by the orchestrator): go for the plan as written; a tap on an option sends that answer at once, without a confirmation step.

Alternatives considered: guidance only (the state before, which produced the problem); a separate owner question tool (a second contract next to `worker_report` for the same open question); a `links` field (the inbox already shows the worker's issue and pull request from the registry, and links invite briefs that point elsewhere instead of carrying the context); a confirmation step after tapping an option (a mis-tap only sends a prompt the owner can correct with a second one).

## Decision

- A `worker_report` with `audience: owner` must carry a complete `brief`, and the daemon refuses an incomplete one with `INVALID_ARGUMENT` naming every missing part, before anything is stored.
- A question needs: a one line `summary` (the one decision), `context`, at least two `options` as `{ label, consequence, recommended }` with a consequence each, distinct labels and exactly one recommended, a `recommendation` and `meanwhile`.
- A blocker needs: a one line `summary`, `context` (with the cause), `tried`, `needed`, a `recommendation` and `meanwhile`; options are optional and follow the question's rules when given.
- `options` are objects for every audience; a question for the orchestrator keeps an optional brief. `tried` and `needed` belong only to a blocker.
- The daemon checks structure. Whether the context is self-contained and free of shorthand, and that one report holds one decision, is carried by the guidance (the `worker_report` description with an example, the worker preamble, the orchestrator instructions and skill) and seen by the owner.
- The decision inbox shows the brief and answers an option with one tap through `orchestration.answer`: the option's label, followed by the typed note when there is one. Free text and "Mark answered" stay.
- Questions stored before this record keep string options; the inbox reads them as options without a consequence. No migration.
- This amends ADR 0016's optional brief for the owner audience.

## Consequences

- An owner question in the inbox always says what is decided, why now, what each answer leads to, what the worker recommends and what happens until the answer.
- Workers still running with the old schema get a refusal that lists what is missing; one retry with the full brief succeeds.
- Asking the owner costs the worker more text; that is the point, the owner pays for the missing context otherwise.
- A mis-tap on the phone sends an answer at once; the owner corrects it with a second message in the worker's chat.

## Revisit when

Owner questions pass the rules and are still not answerable from the inbox, workers routinely bundle several decisions into one, or answers need more than one option (multi select).
