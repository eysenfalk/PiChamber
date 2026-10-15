# 0013. Worker tool profiles: a recorded tool limit per worker, enforced by the daemon, not a sandbox

- Status: Proposed
- Date: 2026-10-15
- Waits for: the owner's review of PR #178 after the live proof

## Context

Issue #151: a worker the orchestrator starts gets every tool, MCP server and extension of the owner's Pi setup. A review worker can edit the code it reviews, and each worker carries the tool schemas of extensions it never needs.

What the pinned SDK offers (Pi 1.1.0, read in `node_modules/@earendil-works/pi-coding-agent` on 2026-10-15): `setActiveTools` decides which tools are sent to the model, but an extension or `tool_search` can activate a tool again, so it is no limit on its own. Every tool call, also a nested `ctx.executeTool` call, passes the `tool_call` hook, which can block it. The resource loader's `extensionsOverride` runs only after every extension was imported and its factory ran, so its tools and event listeners already exist, and package sources are not yet known at that point. `DefaultPackageManager.resolve()` returns the extension resources with their package source before anything is imported, and `noExtensions` plus `additionalExtensionPaths` make the loader import exactly a given list (review of PR #178). MCP servers of the owner's setup reach Pi through extensions (pi-fabric, pi-mcp proxies), so they are excluded as extensions or by their `mcp__<server>__` tool names.

Owner decisions on the plan in PR #178, quoted by the orchestrator: `bash` stays allowed in `read-only`, and instructions and this record say it is a tool limit, not a sandbox; `excludeExtensions` is part of this change, with no default exclusion; `research` runs `full` so research workers can start subagents, `review` and `oracle` run `read-only`.

Alternatives considered: removing tools only from the active set (an extension can turn them on again); a profile per settings file that the owner edits (more surface than two fixed profiles need now); an operating system sandbox for `read-only` (a separate problem, see Revisit when).

## Decision

- Two profiles are defined in code: `full` (nothing excluded) and `read-only` (excludes `edit`, `write`, the writing AFT tools and `*subagent*`, by name pattern with and without an MCP proxy prefix). `bash` stays.
- `session_spawn` and `worker_start` take `profile` and `excludeExtensions`. Without `profile` the role decides: `review` and `oracle` run `read-only`, every other role and a start without role run `full`. An unknown name is rejected before anything is reserved.
- The resolved profile is recorded in the worker's lineage entry and its registry record when it starts. The lineage entry stays the authority after restarts; later code defaults do not change an existing worker. A worker without a record runs unrestricted; a record that cannot be read leaves only reading tools.
- The daemon enforces it in core logic: excluded extensions are never imported into the worker's runtime, matched by path or package source before loading, so they register no tool and no listener (PiChamber's inline extensions always load), excluded tools leave the active set before each run, and the `tool_call` hook blocks every call of an excluded tool with a reason naming the profile.

## Consequences

- A review or oracle worker cannot change files through Pi's or AFT's writing tools, and the model is not sent their schemas. It can still write through `bash`; the profile does not replace review of what a worker did.
- A research worker keeps every tool, including subagents.
- Adding a profile or changing a role default is a code change with tests; existing workers keep what they started with.
- `orchestration_capabilities`, `session_list`, `session_read` and the digest show each worker's profile, so the orchestrator and owner see the limit.

## Revisit when

A worker is expected to be unable to write at all (then `bash` needs a real sandbox), the owner wants profiles beyond `full` and `read-only` in settings, or a Pi update lets a tool call bypass the `tool_call` hook (`tool-profiles.e2e.test.js` fails).
