# Context

Live context: what we know but have not settled yet. Every entry names its source, its date and what will settle it. The pull request that settles an entry, by a decision record, a document or code, removes it here ([ADR 0001](docs/adr/0001-decisions-and-live-context-in-separate-places.md)). Removed entries remain in the Git history.

## Integrations

### pi-fabric calls MCP servers from mcporter without Pi's `tool_call` event

- Source: pi-fabric 0.114.0 (`~/.pi/agent/npm/node_modules/pi-fabric`, read only): `dist/fabric-runtime-state.js` (`#emitToolCallPreflight`, the `pi-tools` and extension providers), `dist/chunks/chunk-V2SKDVQX.js` (mcporter calls); a probe through a real daemon with a stdio MCP server on 2026-10-16 (PR #230)
- Date: 2026-10-16
- Settled by: the owner's decision on PR #230 how a worker's tool profile treats Fabric's `mcp.*`, or pi-fabric emitting `tool_call` for its MCP calls

In Fabric full code mode a `fabric_exec` program calls Pi tools as `pi.*` and extension tools as `extensions.*`; both reach Pi's tool execution, so a worker's tool profile blocks them (`tool-profiles-fabric.e2e.test.js`). Its `mcp.*` calls to servers from mcporter (`~/.mcporter/mcporter.json`) go to `runtime.callTool` directly and emit no `tool_call`, so no Pi extension can block them: in the probe a read-only worker ran an MCP tool named `subagent_echo` that `*subagent*` would exclude. Servers through Pi's own MCP (`mcp.nativeServers`) do go through `executeTool`. pi-fabric has no per session policy hook: approvals come from `fabric.json`, `PI_FABRIC_TOOL_ALLOWLIST` is read from the process environment, which the daemon shares across sessions.

### pi-subagents shows its async run status to RPC hosts as one versioned widget line

- Source: pi-subagents (`/home/feysen/projects/private/gh/pi-subagents`, read only): `src/runs/shared/async-status-projection.ts`, `src/runs/background/async-status-snapshot.ts`, `docs/observability.md`; observed in a real PiChamber session with a test extension on 2026-10-03
- Date: 2026-10-03
- Settled by: a decision record or a `DOCUMENTATION.md` of the Pi extension protocol that states which widget protocols the daemon supports, or pi-subagents changing the protocol

An RPC host receives the async status snapshot as widget `subagent-async`, line 0: `PI_SUBAGENT_ASYNC_JSON:` followed by JSON with `kind` `pi-subagents.async-status-snapshot` and `version` 1, capped at 32 KiB serialized. Hosts must not render the widget `subagent-inspect`; it carries on demand inspect replies. Before #30 the bridge and the public route projection cut every widget line at 2000 characters, which broke any larger snapshot; they now keep the `subagent-async` line 0 whole up to the cap. A new version, kind or node state makes the card show "Subagent status unavailable" until its parser learns it.

### The proof lab has no model; Pi's faux provider scripts one

- Source: `lab/README.md` and the #110 worker's report (2026-10-12); `@earendil-works/pi-ai` `providers/faux` used by `session-daemon/orchestration/orchestration.e2e.test.js`
- Date: 2026-10-12
- Settled by: a decision record on which model lab recordings use, or a model configured in the lab

The lab image carries no provider credentials, so a recording of agent behavior needs a scripted model. Pi's faux provider registers a model whose replies, including tool calls, come from a script; the orchestration daemon test drives a real runtime with it.

### Pi starts a prompt's run in the same synchronous step that reports `started`, and gives the run no identity

- Source: `@earendil-works/pi-coding-agent` 1.1.0 `dist/core/agent-session.js`: `preflightResult?.("started")` at line 1630 and `await this._runAgentPrompt(messages)` at 1631, the `before_agent_start` emit at 1591, `abort()` at 1909; `@earendil-works/pi-agent-core` 1.1.0 `dist/agent.js`: `signal` at 214 (`activeRun.abortController.signal`), `abort()` at 219, `prompt()` refusing while `activeRun` exists at 342, `activeRun` set at 350; checked with the faux provider in `session-daemon/orchestration/run-binding.e2e.test.js` (#125 round 7)
- Date: 2026-10-13
- Settled by: a Pi release that gives a prompt a run id, or that awaits between `started` and the run start

Pi's `started` callback carries no run handle, and `AgentSession.abort()` aborts whatever run the agent has. Between the `isStreaming` check and `started` lie more awaits (auth, compaction, `before_agent_start`), so a prompt can report `started` while another prompt's run owns the agent; its own `Agent.prompt()` then fails, and a session wide abort would hit the other run. PiChamber reads the agent's `signal` one microtask after `started`: a new signal is this prompt's run, the old one means it got none. This depends on Pi starting the run without an await after the callback. If a Pi update breaks that order, `run-binding.e2e.test.js` fails.

### Pi emits `agent_settled` for a rejected prompt while another prompt's run is live

- Source: `@earendil-works/pi-coding-agent` 1.1.0 `dist/core/agent-session.js`: `_runAgentPrompt()` at line 1380 to 1414 (`await this.agent.prompt(messages)` at 1390, `await this._emitAgentSettled()` in its `finally` at 1412), `_emitAgentSettled()` at 684 to 707 (clears `_isAgentRunActive` at 686, so `isStreaming` turns false while the other run goes on), the retry loop with `agent.continue()` at 1391 to 1403; `@earendil-works/pi-agent-core` 1.1.0 `dist/agent.js`: `prompt()` refusing while `activeRun` exists at 342, `finishRun()` clearing the run before the settle at 383 to 388; checked with the faux provider in `session-daemon/orchestration/run-binding.e2e.test.js` (#125 round 8)
- Date: 2026-10-13
- Settled by: a Pi release that emits `agent_settled` only for the prompt that owned the run, or that gives `agent_settled` a run id

When a prompt reports `started` but `Agent.prompt()` refuses it because another prompt's run owns the agent, its `_runAgentPrompt` still emits `agent_settled` from its `finally` while the other run is live. A real settle comes after `finishRun()` cleared the run, so `session.agent.signal` is undefined then; at the false one it is the live run's signal. The daemon therefore treats a settle with a signal, also an aborted one, as no completion (`isSettleFinal`). The converse does not hold: between a run's end and its retry `continue()` the signal is undefined too, so no signal does not prove that the prompt is over. Pi 1.1.0 has no run id that would settle this; the contract in `session-daemon/DOCUMENTATION.md` keeps an occupancy whenever the evidence is missing or contradicts.

### A run's end is proven only by the end of the prompt that started it

- Source: `@earendil-works/pi-coding-agent` 1.1.0 `dist/core/agent-session.js`: `_prepareRetry()` at line 3028 to 3062 (sleeps the backoff after the attempt's run ended, `isRetrying` true, no `agent.signal`), its call in `_handlePostAgentRun()` at 1426 followed by `agent.continue()`, `_runAgentPrompt()` at 1380 to 1414 (`prompt()` resolves only after the retries, continuations and `_emitAgentSettled()`), the deferral of a prompt during `agent_settled` at 1518 to 1521 (that `prompt()` resolves before its deferred run, without a verdict); checked with the faux provider in `session-daemon/orchestration/run-binding.e2e.test.js` (retry backoff) and `admission.e2e.test.js` (W2) (#125 round 8 addendum)
- Date: 2026-10-13
- Settled by: a Pi release that gives each logical run an id carried by its `started` verdict and its `agent_settled` event

While a run waits to retry, `session.agent.signal` is undefined although its prompt goes on, so a settle that arrives then (for example a rejected prompt's false settle released from a slow `agent_settled` handler) looks like a completion. The daemon therefore frees a run's slot and directory only when the `prompt()` call that reported its `started` verdict resolved and the run's signal is gone (`provenRunEnd`). A prompt Pi runs again from its deferred settle actions has no such call: its late verdict's run keeps the occupancy as `unproven_run` until the holding process is dead, and Slice 4 reports it.

### Pi's prompt() decides between a new run and a queued input only after its own awaits

- Source: `@earendil-works/pi-coding-agent` 1.1.0 `dist/core/agent-session.js`: `prompt()` at line 1517, the deferral at 1518 to 1521, the `isStreaming` check at 1551, `_emitAgentSettled()` at 684 to 707; checked with the faux provider in `session-daemon/orchestration/admission.e2e.test.js` (#125 round 5)
- Date: 2026-10-13
- Settled by: a Pi release that decides and starts a run without awaiting in between, or that always calls `preflightResult`

`prompt()` awaits extension commands (slash input) and the `input` handlers before it checks `isStreaming`. A run that was live when the caller checked can settle inside that window, and Pi then starts a new run instead of queueing the input, so a check before the call cannot decide whether the input takes a slot; only the `preflightResult` verdict (`started`, `queued`, `handled`) can. A `prompt()` made while `agent_settled` handlers run is pushed onto the deferred settled actions and resolves at once without calling `preflightResult`; its run, and its `started` signal, come after the handlers. The deferred action calls `prompt()` again with the same options, so the late signal is that call's `preflightResult`. The handlers run in one loop: when an earlier deferred action throws, the later ones never run and their prompts never get a signal. The daemon treats that return as accepted and keeps a worker's admission `unresolved` until the late signal or a stop (`session-daemon/DOCUMENTATION.md`).

### Pi maps thinking levels to Anthropic effort; Claude 5.5 always thinks

- Source: Anthropic docs `choosing-a-model` and `build-with-claude/effort` ("Recommended effort levels", read by the orchestrator 2026-10-12); `@earendil-works/pi-ai` 1.1.0 `providers/data/anthropic.json` (`thinkingLevelMap`) and `api/anthropic-messages.js`, checked with a payload probe through `onPayload`
- Date: 2026-10-12
- Settled by: Pi changing the Claude 5.5 `thinkingLevelMap`, or new Claude models that need new role defaults

For `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5`, Pi supports `low`, `medium`, `high`, `xhigh` and `max`, and sends each one as the same Anthropic effort with adaptive thinking. `off` and `minimal` map to null: Pi and the daemon (`thinking-levels.js`) raise them to `low`, so thinking never turns off, which the API would reject with 400. The orchestration role defaults are the owner's values (2026-10-12) with Anthropic's recommended effort levels as background; the e2e test checks that every Claude default is a level its model supports, so `xhigh` for `debug` and `task-extreme` reaches Opus 5.5 as effort `xhigh`.

### Intent checkpoints rely on Pi extension behavior that is not proven yet

- Source: Pi 1.0.2 `docs/extensions.md` (`pi.appendEntry()`, `turn_end`) and `docs/session-format.md` (forks); `packages/web/server/lib/pi/session-daemon/DOCUMENTATION.md` (blocking extension dialogs); ADR 0006
- Date: 2026-10-05
- Settled by: the prototype in #70

Two things ADR 0006 assumes are untested. A blocking dialog opened from `turn_end` must stop the session cleanly, also while the agent wants to continue; the record now blocks only on hard changes, but those still need it. A fork at an entry must keep the `appendEntry` entries on its path, so a fork carries the checkpoints, rejections and confirmed relations up to its fork point; Pi 1.0.2 documents the parent link of a fork but not whether custom entries are copied.

## Release

### Releases of the fork are built locally, not by release.yml

- Source: `gh release list` and `gh run list --workflow release.yml` on `eysenfalk/PiChamber`; `gh secret list` (empty); `.github/workflows/release.yml`, `.github/workflows/mobile-release.yml`, `CONTRIBUTING.md` "Releases"
- Date: 2026-10-04
- Settled by: a decision record on how the fork releases, or Android signing secrets in GitHub and a first successful `release.yml` run

`CONTRIBUTING.md` describes releases by `release.yml` on a `vX.Y.Z` tag, building every desktop platform, Docker and the signed Android app from GitHub secrets. The fork has no Actions secrets and no successful `release.yml` run. Every release so far was built on the owner's machine: the APK signed with the local release key in `~/.config/pichamber/`, the AppImage with `bun run electron:build`, uploaded with `gh release create`. Their tags (`v1.0.3-android.1` to `v1.0.5-android.5`, `v1.0.6-build.6`) do not match the workflow's version pattern, so the triggered `release.yml` stops in `create-release` without building or publishing anything.

## Networking

### The owner's LAN address is not reachable from the phone, the Tailscale address is

- Source: session `01a0f83f` (2026-10-01): pairing over `http://192.168.178.95:39603` failed from the Android app while `http://100.120.83.24:39603` worked, ufw inactive; #46
- Date: 2026-10-01
- Settled by: finding the cause on the owner's network (router client isolation, a guest Wi-Fi or a host firewall) and documenting it in `connect-devices.mdx`

Pairing now defaults to Tailscale with an optional Wi-Fi fallback (#46), which avoids the problem but does not explain it. On a tested emulator the same LAN address and port were reachable over TCP (2026-10-05), so the server binds and listens correctly; the block sits between phone and host.

## Upstream

### The fork's workflow files differ from upstream

- Source: pull request #10 changes `AGENTS.md`, `CONTRIBUTING.md` and `.github/PULL_REQUEST_TEMPLATE.md`, which `RyderAsKing/PiChamber` also maintains
- Date: 2026-10-02
- Settled by: a decision record on how the fork follows upstream (merge, rebase or cherry-pick) and which files it keeps as its own

### Plan documents in docs/plans

- Source: `docs/plans/github-pull-requests-and-issues.md` ("Status: accepted", added in 6c1fe72a on 2026-09-27)
- Date: 2026-10-02
- Settled by: a pull request that moves its lasting decisions into a decision record or the owning `DOCUMENTATION.md` and deletes the file

The workflow keeps no archive of plans; plans live in pull requests and their squash commits.
