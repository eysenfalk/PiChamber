# 0019. Worker skill selection: a worker's prompt lists the skills its start chose, part of its recorded tool profile

- Status: Proposed
- Date: 2026-10-16
- Waits for: the owner's review of PR #230

## Context

Issue #226: a worker the orchestrator starts lists every skill of the owner's Pi setup in its system prompt, around fifty user and package skills plus its project's, most of which its task never needs. Worker tool profiles ([ADR 0014](0014-worker-tool-profiles.md)) already record a per worker limit in the lineage and apply it when the daemon creates the worker's runtime.

What the pinned SDK offers (Pi 1.1.0): the resource loader takes a `skillsOverride` that receives the loaded skills and returns the ones the prompt lists. `DefaultPackageManager.resolve()`, which the daemon already calls for excluded extensions, returns the skill resources with their scope, so the project's skills are known by path. The repository's AGENTS.md makes its project skills mandatory for every change.

Owner decisions relayed by the orchestrator on the plan in PR #230: project skills always stay; the role skill defaults stay unset, so no owner skill names are in code.

Alternatives considered: a separate `skills` lineage field next to `profile` (a second record with the same lifecycle, read on the same paths); removing skills from the agent directory per worker (writes the owner's `~/.pi/agent`); a list of skill names per role shipped in code (names the owner's own skills).

## Decision

- `session_spawn` and `worker_start` take `skills`, a list of skill name patterns with `*`. Without it the role's `orchestration.roles.<role>.skills` setting applies; without that the worker lists every skill, as before.
- The choice is part of the tool profile record: `profile.skills`. It is recorded in the lineage and the registry with the profile, so a reopened worker lists what it started with, and `session_list`, `session_read` and the digest show it.
- When the runtime is created the daemon filters Pi's loaded skills through `skillsOverride`: a skill stays when a pattern matches its name or Pi resolved it as a project skill. `[]` keeps the project skills only. An unreadable record keeps the project skills only.
- `orchestration_capabilities` lists the names of the skills the caller's session loaded, so the orchestrator chooses from real names.

## Consequences

- A worker's prompt is shorter and carries only the skills its task needs, plus its project's.
- It is no security limit: a worker can still read a skill file by path.
- A project skill added while a worker runs appears after its next new runtime, not on `/reload`, because the project skills are resolved when the runtime is created.
- Role defaults live in the settings file; there is no settings UI for them yet. A model picker write without `skills` keeps the stored ones.

## Revisit when

A worker should drop its project skills, the owner wants role skill defaults in the settings UI, or a Pi update changes `skillsOverride` or the resolved skill scope (`tool-profiles.e2e.test.js` fails).
