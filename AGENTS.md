# PiChamber Agent Guide

## Purpose

PiChamber provides web, desktop, hosted-mobile, and native-mobile UI surfaces for Pi Coding Agent.

> PiChamber is a community fork of [OpenChamber](https://github.com/openchamber/openchamber), now running through its Pi-native session daemon.

This file contains only always-on repository rules and routing. Detailed workflows belong to project skills and module documentation.

## Instruction Order

These steps are mandatory. Before editing, you **MUST**:

1. Follow this root guide.
2. Load every matching project skill and every task-required reference from
   those skills.
3. Read the nearest `DOCUMENTATION.md` and package `README.md` when present.
4. Follow local code and test precedent.

If these sources materially conflict, stop and resolve the conflict instead of silently choosing one.
Do not start editing when a matching skill or required reference has not been
read. Skill loading is a required part of the task, not optional guidance.

## Runtime Boundaries

- `packages/ui`: shared React UI, state, sync, and runtime contracts.
- `packages/web`: web surfaces, PiChamber server, Pi session-daemon lifecycle, and CLI.
- `packages/electron`: native desktop shell and privileged Electron boundary.
- `packages/mobile`: Capacitor iOS/Android shell; bundles the mobile web surface and connects to an existing PiChamber server.
- `packages/docs`: product documentation; not a Bun workspace.

Shared UI calls Pi through `/api/pi/*` using `runtimeFetch` and shared browser/realtime transport helpers. Runtime-specific PiChamber capabilities use `RuntimeAPIs`.

Electron starts the PiChamber backend in-process, never as a sidecar. Development may load loopback/HMR UI; packaged builds load staged assets through `pichamber-ui://` while the loopback server remains the API backend. Keep domain backends in web/runtime modules unless behavior is inherently native.

Shared contracts must define intentional behavior for every applicable runtime: web, desktop, hosted mobile, and Capacitor mobile.

## Always-On Constraints

- Do not modify `../opencode`; it is a separate repository.
- Git and GitHub follow the workflow below; do not run commands outside it unless the user asks.
- Do not add dependencies unless explicitly requested.
- Never add or log secrets, bearer tokens, pairing credentials, or sensitive user data.
- Keep changes minimal and preserve unrelated worktree changes.
- Enforce security and correctness in core/runtime logic, not only UI visibility or prompts.
- Keep entrypoints and bridges thin; place domain logic in focused owning modules.
- Update owning documentation when module ownership, contracts, or invariants change.

## Workflow

Work follows [docs/workflow.md](docs/workflow.md) ([ADR 0002](docs/adr/0002-workflow-from-jira-connector.md)); `workflow.json` names the tracker.

1. A GitHub issue in `eysenfalk/PiChamber` says what is missing and how we know it is done. Planned work is a roadmap item: an issue labeled `roadmap` and a sub-issue of the roadmap issue (`tracker.roadmap` in `workflow.json`), whose order is the order of work.
2. Branch `<issue>-short-name` from `origin/main`, push it, and open a **draft** pull request from `.github/PULL_REQUEST_TEMPLATE.md`. The description is the plan.
3. Wait for the user to approve the plan. Do not implement before.
4. Implement and prove: tests, and for anything a user sees, a recording or screenshots of the real program that you have looked at completely, with how to reproduce them. Check off each acceptance criterion in the description as soon as it is done and proven.
5. Decisions go into `docs/adr/`, findings from outside the code into `CONTEXT.md`, settled entries leave `CONTEXT.md`, all in the same pull request. The squash merge closes the issue, which takes it off the roadmap.
6. Before the hand-over, check the whole description against the current code, CI result and proof, then mark the pull request ready. The user merges (squash only).

Without asking, agents may: create and push branches other than `main`, open and update draft pull requests in `eysenfalk/PiChamber`, create issues, place and reorder roadmap items and add ideas to the roadmap issue (`node scripts/workflow/roadmap-sync.mjs`, docs/workflow.md), and add `Proposed` decision records.
Only with approval: implement a plan, mark a pull request ready or merge it, push to `main`, rewrite pushed history, tags and releases, repository settings, close issues, and anything in an upstream repository.

## Correctness Invariants

- Prefer authoritative state over heuristics.
- Derive live activity from live channels, not persisted history.
- Scope temporary fallbacks narrowly and clear them when authoritative state arrives.
- Never let fetch failure masquerade as authoritative empty success.
- Make partial results, rollback, cleanup, and stale-data behavior explicit.
- One failed entity must not erase or block unrelated complete entities.
- Runtime-specific differences must be intentional and visible in code.

## Documentation Discovery

Before changing a module, search for the nearest `DOCUMENTATION.md`; before package-level work, read its `README.md`. Discover docs dynamically under `packages/**/DOCUMENTATION.md` rather than relying on a static exhaustive map.

High-value anchors:

- Sync: `packages/ui/src/sync/DOCUMENTATION.md`
- Stores: `packages/ui/src/stores/DOCUMENTATION.md`
- CLI: `packages/web/bin/lib/DOCUMENTATION.md`
- Performance measurement tooling: `scripts/perf/DOCUMENTATION.md`
- Electron: `packages/electron/README.md`
- Mobile: `packages/mobile/README.md`

## Project Skills

Project skills live under `.agents/skills/*/SKILL.md`. You **MUST** load every
skill matching the character of the change before editing; multiple skills may
apply, including companion skills required by another skill. Read every
task-required reference named by those skills. Skills are canonical for their
detailed workflows and checklists. Treating this table as optional advice is a
process violation.

| Trigger | Required skill |
|---|---|
| Any source, dependency, export, build-config, generated-asset, package-contract, or module-ownership change | `pichamber-change-discipline` |
| Visual proof, lab tours, recordings or proof publishing | `pichamber-verify` |
| CLI commands, prompts, terminal output, non-TTY, `--quiet`, or `--json` behavior | `clack-cli-patterns` |
| Shared UI data access, Pi API, `RuntimeAPIs`, runtime fetch/auth/URLs, bridges/proxies, runtime switching, or server API routes | `ui-api-decoupling` |
| Electron main/preload, IPC, native UI, updater, deep links, SSH/tunnels, packaging, or child processes | `desktop-shell` |
| Session sync, bootstrap/reconnect, reducers, polling, optimistic state, queues, live status, reconciliation, or directory-scoped caches | `sync-state-invariants` |
| Render/store/event hot paths, large lists, caching/indexing, high CPU/memory, lag, jank, freezes, or performance regressions | `performance-engineering` |
| WebSocket, SSE, streaming transport, runtime transport internals, or private relay | `relay-transport` |
| UI components, styling, colors, buttons, or icons | `theme-system` |
| User-facing or accessible UI text, labels, aria, toasts, dialogs, or navigation copy | `locale-ui-patterns` |
| Settings UI, settings dialogs, configuration surfaces, or settings search | `settings-ui-patterns` |
| Sortable or drag-to-reorder behavior, especially `@dnd-kit` and touch/wrapping layouts | `drag-to-reorder` |
| iOS Simulator build, launch, preview, gestures, or `serve-sim` control | `serve-sim` |

Pure code-reading or explanation does not require implementation skills unless needed to interpret a specialized subsystem.

## Validation

- Tests needing a separate environment (lab, recordings and acceptance tests through the lab) run through `lab/run`. Install, builds, type checks, lint, unit tests and all other work stay on the host. Load `pichamber-verify` for visual proof.
- Use `package.json` scripts as the command source of truth.
- Prefer focused tests and package-scoped type-check/lint for executable source changes.
- `bun run test` runs every unit suite (web, ui, electron) and must pass before handoff. UI tests run under `bun test --isolate` (per-file isolation) because bun's `mock.module()` is process-global; keep new UI test files self-contained and avoid partial mocks of shared modules.
- Use workspace-wide checks for cross-workspace contracts, root tooling, dependencies, or shared generated assets.
- Run `bun run dead-code` when source files are added/deleted/renamed or exports, types, entrypoints, or import shape change; inspect its report because it is non-blocking.
- Do not assume TypeScript/lint covers server JS, CLI JS, Electron helpers, or native behavior; run focused tests, syntax checks, builds, or runtime validation for the touched surface.
- For docs-only or isolated config changes, run the narrowest relevant validation.
- Report exactly what was and was not validated. Static checks alone do not prove runtime, relay, performance, or platform correctness.

## Pull Request Handoff

Before creating or updating a pull request, read `docs/workflow.md`,
`CONTRIBUTING.md` and `.github/PULL_REQUEST_TEMPLATE.md`. Complete the template
with concrete, current evidence for the final PR HEAD; do not make the reviewer
reconstruct intent, affected surfaces, applicable guidance, validation, visual
behavior, or failure and rollback considerations from the diff alone. The
`pull-request` check enforces the sections, the issue reference and the
checklist.
