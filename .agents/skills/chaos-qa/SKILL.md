---
name: chaos-qa
description: Use when hunting PiChamber bugs nobody has seen yet, by checking a change's or area's assumptions against the real environment, by exploratory and chaos testing of a running build, or both. Returns reproduced findings filed as GitHub issues plus a coverage report; use debug-style investigation for an already observed failure and pichamber-verify for proving planned behavior.
---

# Chaos QA

The job a QA engineer used to do: assume the change is broken and find out where. Tests, review and screenshots check what the author thought of. This skill looks for what nobody thought of, and it does not fix anything.

Two ways, chosen per run:

- **Analysis**: find bugs without using the program, by falsifying assumptions against the real environment.
- **Chaos**: find bugs while using the program, by driving a real build and attacking it.
- **Both**: analysis first; its suspicions become the first chaos targets.

## Before starting

1. Write a charter: target (PR number, diff, module or user flow), way, timebox, and what counts as a failure for this target (lost session, stuck state, wrong data, unauthenticated access, silent fallback). Without a timebox, use 30 minutes per way.
2. Read the target's diff or code, its nearest `DOCUMENTATION.md`, and [references/fragile-areas.md](references/fragile-areas.md) for the areas it touches.
3. Load the project skills whose subsystem the target touches (`sync-state-invariants`, `relay-transport`, `desktop-shell`, `ui-api-decoupling`, ...). Their invariants are test oracles here.
4. Record the build under test: commit, dirty flag, runtime, how it was started.

## Safety boundary

- Never attack the owner's running instance: not the desktop app or AppImage, not port 39603, not `~/.pi/agent`, not real projects or sessions. Before any kill, pause or signal, confirm the target PID belongs to the lab or to an instance this run started (port, cwd, `PICHAMBER_DATA_DIR`).
- Chaos runs in the proof lab by default. A host instance is allowed only when the lab cannot run the scenario (desktop shell, live model turns, platform behavior), isolated as described in [references/chaos-actions.md](references/chaos-actions.md). Live model turns cost money: ask before using a real provider.
- No host firewall, network or disk manipulation. No real credentials, tokens or pairing codes in logs, issues or screenshots.
- Analysis probes are read-only on the host: inspect processes, run code in `/tmp`, run existing tests. Do not edit the repository.

## Way 1: Analysis

1. List the load-bearing assumptions of the target, one line each: what the code believes, where (file:line), and what happens if it is false. Typical sources: environment variables, platform and runtime checks, heuristics standing in for authoritative state, "cannot happen" branches, ordering and timing, sizes and limits, defaults.
2. Try to falsify each assumption with a probe against the real environment, not a mock: read `/proc/<pid>/environ` of real processes, run the code path under Node and Bun, check what Electron, systemd, a terminal and the lab actually set, measure the real size or timing. One assumption, one probe, recorded with its output.
3. Walk every failure path of the target: each I/O or await fails, hangs, returns twice, returns late or out of order, returns empty versus fails. Check that the failure stays visible and that partial results, cleanup and rollback match the `pichamber-change-discipline` and `sync-state-invariants` rules.
4. Walk the runtime matrix: web, desktop, hosted mobile, Capacitor; Linux, macOS, Windows; Node and Bun; source checkout versus build versus AppImage. Name each cell as checked, not applicable (why), or unchecked.
5. Check security on the target: authentication on every new route, what reaches logs, unbounded input, paths and commands built from input.
6. Reproduce each suspected defect: a probe, script or failing test under `/tmp/chaos-qa/<run>/`. What cannot be reproduced stays a suspicion.

## Way 2: Chaos

1. Start the environment: `lab/run status`, then `lab/run up` after `bun run build` (see `pichamber-verify` for ownership and staleness). The lab is offline and has no model; it covers UI, sync, daemon lifecycle, persistence and transport without live turns.
2. Drive a real browser over CDP with the helpers in `scripts/perf/cdp.mjs`, desktop 1440x900 and mobile 390x844, light and dark where the target renders.
3. Walk the happy path once, recording what normal looks like.
4. Attack with the catalogue in [references/chaos-actions.md](references/chaos-actions.md): input abuse, interruption at every step, process and transport faults, concurrency, state and reload, hostile data. Pick actions that hit the charter's failure definition; do not run the catalogue blindly.
5. Use a seed for every random choice and keep an action log with timestamps, so a failing sequence can be replayed exactly.
6. On anything odd: stop, save screenshot, console errors, failed network requests and server log lines, then replay from the log until it reproduces or clearly does not. Reload or switch sessions only after capturing the live state, because a reload hides live-state bugs.
7. Finish with `lab/run down` and stop every instance this run started.

## Findings

Follow [references/finding-and-report.md](references/finding-and-report.md). In short:

- A **finding** is reproduced at least twice, with steps, expected and actual behavior, severity and evidence. Search open and closed issues first, then file one GitHub issue per finding with the `bug` label. Do not add it to the roadmap; the owner prioritizes.
- A **suspicion** is anything not reproduced. It stays in the report with what was tried.
- Name the suspected cause only as a hypothesis with its evidence. Do not fix it in this run.

## Done when

- The charter is covered or the timebox is used up, and the report says which.
- The report lists findings with issue links, suspicions, the assumption table (way 1), the attack log summary (way 2), and the runtime cells left unchecked.
- Coverage that found nothing is reported too: what was attacked and held.
- The lab is down, started instances are stopped, `/tmp/chaos-qa/<run>/` holds the logs and evidence.
