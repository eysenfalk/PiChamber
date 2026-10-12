# 115. Fixed orchestrator

Temporary spec for #115 with its parts #116, #117, #118 and #119 ([ADR 0009](../../docs/adr/0009-spec-folder-for-multi-pr-features.md)). The last pull request of the feature deletes this folder after moving what must last into `packages/web/server/lib/pi/session-daemon/DOCUMENTATION.md`, the `orchestrator` skill and a decision record.

## Next agent prompt

Status 2026-10-12: plan only, nothing implemented. The plan waits for the owner's approval in the draft pull request that adds this folder. Slice 1 starts after #107 (PR #113) is merged into `dev`; the skill parts of each slice need #110 (PR #112) merged.

You are picking up the fixed orchestrator. Read this README, then the slice file of the next open slice, then `AGENTS.md`, `docs/workflow.md`, `packages/web/server/lib/pi/session-daemon/DOCUMENTATION.md` and every project skill the slice names. Work in one branch and one draft pull request per slice, based on `origin/dev`. Start a slice only after the slices it depends on (see Ladder) are merged into `dev`; slices are not stacked. Do not implement before the owner approved the pull request's plan.

Next pickup: [slice 1, Registry and takeover](slices/1-registry.md), once #113 is merged.

Blockers: #113 not merged. The role list is settled: #107 moves to the eleven roles of #112 (`orchestrate`, `plan`, `oracle`, `debug`, `task-easy` to `task-extreme`, `research`, `small`, `review`) before its merge.

Global TODO:

- [ ] [1 Registry and takeover](slices/1-registry.md) (#118), `task-hard`
- [ ] [2 Worker reports and digest](slices/2-reports-digest.md) (closes #117), `task-medium`
- [ ] [3 Wake events and watchdog](slices/3-wake-watchdog.md) (#116), `task-hard`
- [ ] [4 Rewind and remedy for known failures](slices/4-remedies.md) (closes #116), `task-hard` with `debug`
- [ ] [5 Resource gate and lab lock](slices/5-resource-gate.md) (#119), `task-medium`
- [ ] [6 GitHub events](slices/6-github-events.md) (closes #119), `task-medium`
- [ ] [7 Start and cleanup](slices/7-start-cleanup.md) (closes #118), `task-extreme`
- [ ] [8 End to end and close out](slices/8-close-out.md) (closes #115, deletes this folder), `task-medium`

When you finish a slice: check its box, update the status line and the next pickup, and correct anything in this spec the work proved wrong, in the same pull request.

## Goal

The orchestrator session works on events and digests instead of polling and raw transcripts. It is woken when a worker finishes, asks, fails or stalls, or when its pull request changes; it sees every worker in one compact call; its bookkeeping lives in PiChamber, not in its context; starting a worker for an issue and cleaning up after the merge are one call each. The orchestrator itself does no implementation work.

Non goals: worker depth beyond 1, token or cost budgets, the decision inbox (#87), an orchestrator view (#20), new session states in the UI (#106), a new dependency.

## Decisions

Taken by this plan. The owner can overturn any of them in the plan review; each names the slice that depends on it.

| # | Decision | Slice |
|---|---|---|
| O1 | One durable **orchestration registry** in the daemon, a JSON file next to the other PiChamber stores (`<dataDir>/pi/orchestration-registry.json`, per-file lock, atomic replace). It owns which orchestrator owns which worker plus role, issue, branch, worktree, pull request, bookkeeping state, latest report, open question, pending events and the lab lock. The parent's `pichamber.orchestration.child` and `stopped` JSONL entries from #107 are imported once and then no longer read. The worker's own lineage entry stays: it marks a session as a worker and keeps sidebar nesting. | 1 |
| O2 | Live state (busy, idle, retry, waiting for input, progress, running commands) is never stored in the registry. It is derived from the daemon's live channels, and the digest joins both. | 1, 2 |
| O3 | A new orchestrator takes over the workers of an old one with one tool call; result and event delivery then follows the registry, not the JSONL parent. | 1 |
| O4 | Workers report through a `worker_report` tool whose kinds reuse the #112 status words (`progress`, `question`, `blocked`, `ready`, `done`). A question stays open until the next input reaches that worker, from the orchestrator or the owner. | 2 |
| O5 | All wakes go through one **event bus** per orchestrator. It delivers one `pichamber.orchestration.events` message per burst: after a short coalescing window when the orchestrator is idle, on its next settle when it is busy. Pending events are kept in the registry, so a busy orchestrator or a daemon restart does not lose them. The per-settle `pichamber.orchestration.result` message of #107 goes away; its content moves into the digest. | 3 |
| O6 | The **watchdog** is daemon code fed by the daemon's own lifecycle, message and tool events; one 15 second tick checks stall deadlines of registered workers only. Thresholds and remedies are settings and can be switched off. | 3, 4 |
| O7 | Auto remedies are a small table of known failures, each with a match on the error, a safe action and a report. Anything else is only reported. The first entry is the provider 400 for an image in an error tool result; its remedy rewinds the worker to the last good tree entry and prompts it again. | 4 |
| O8 | The worker limit counts every active registered worker of the daemon, not per orchestrator tree. Spawning also refuses when the host is over the owner's thresholds (1 minute load above the core count, less than 8 GB available), with the measured numbers in the reason. | 5 |
| O9 | The lab lock is a lease in the registry (holder, since, expiry, renew by acquiring again), released when the holder stops, is removed or the lease expires. The orchestration extension blocks a worker's `lab/run up` and `lab/run record` while that worker does not hold the lease. | 5 |
| O10 | GitHub state of the workers' pull requests is read in the daemon process through the existing `packages/web/server/lib/github` module (one owner of GitHub access), polled at most every 60 seconds and only while a registered worker has a branch. A pure mapping turns state changes into bus events. The orchestrator itself never polls. | 6 |
| O11 | `worker_start` writes the registry record before its first side effect and records every step it completes, so a failure leaves a `start_failed` worker with the created artifacts named; a retry with the same `clientRequestId` resumes, `worker_abandon` removes only what this start created. | 7 |
| O12 | Cleanup after a merge runs the #112 checks (pull request `MERGED`, local tip equals the merged head, clean worktree) before it deletes the session, the worktree (never `--force`), the local and the remote branch. A failed check leaves `cleanup_blocked` and an event, never a partial guess. A setting switches automatic cleanup off; `worker_cleanup` runs it by hand. | 7 |
| O13 | Rewind and delete are tools of this epic, not of #107 (orchestrator decision 2026-10-12): `session_rewind` in slice 4, used by the remedy and by the orchestrator, over the daemon's `sessions.navigate`; `session_delete` in slice 7, used by cleanup, over the daemon's `deleteSession`. Both act only on the caller's registered workers. Fork is not offered: it gives the worker a new session id, so registry, lineage and the orchestrator's handle would have to move, while navigate keeps the id and Pi's tree keeps the abandoned branch. | 4, 7 |
| O14 | Each slice updates the base instructions (`instructions.js`) and the `orchestrator` skill for the tools it adds, in the same pull request, as #112 requires for renames. | 1 to 7 |
| Ladder | Eight pull requests, not stacked, each started after the slices it depends on are merged into `dev` ([ADR 0008](../../docs/adr/0008-dev-integration-branch.md)). Slices 4, 5 and 6 may run in parallel after slice 3. The spec pull request itself is docs only and based on `dev`. | all |

Rejected:

- **Stacking on `107-orchestration-mcp`.** #113 is a draft with its MCP route, Settings UI, sidebar nesting and lab proof still open; every change there would force a rebase of all slices, and ADR 0008 has slices land on `dev`. If #113 slips for long, the owner can decide to stack slice 1 only.
- **Keeping bookkeeping in the orchestrator's JSONL** (#107's choice): it survives compaction and restart, but takeover would have to rewrite another session's log, and limits across trees would scan every orchestrator.
- **Polling `gh` from the orchestrator or a script:** costs tokens on every check, which #115 removes.
- **A separate watchdog process:** the daemon already sees every event and owns the runtimes.
- **Delivering each event as its own Pi follow-up:** a burst becomes several turns.

## Ladder

```text
                                           ┌─► 4 remedies ───────────────┐
1 registry ─► 2 reports+digest ─► 3 wake+watchdog ─┼─► 5 resource gate+lab lock ─┼─► 7 start+cleanup ─► 8 end to end
                                           └─► 6 GitHub events ──────────┘
```

| Slice | Depends on | Parallel with | Role | Size guess |
|---|---|---|---|---|
| 1 | #113 merged | none | `task-hard` | 400 to 550 |
| 2 | 1 | none | `task-medium` | 300 to 450 |
| 3 | 2 | none | `task-hard` | 450 to 600 |
| 4 | 3 | 5, 6 | `task-hard` | 200 to 400 |
| 5 | 3 | 4, 6 | `task-medium` | 350 to 500 |
| 6 | 3 | 4, 5 | `task-medium` | 300 to 450 |
| 7 | 5, 6, #112 merged | none | `task-extreme` | 500 to 700, split if larger |
| 8 | 4, 7 | none | `task-medium` | 150 to 300 plus deletions |

Slices 4, 5 and 6 own separate modules (`remedies.js`, `activity.js` with the lab lease, `github-watch.js`). Their shared touch points are `tool-contracts.js`, `settings-store.js`, `instructions.js` and the skill; whoever merges second rebases on `dev` and resolves those. With the four-worker limit, at most three implementation workers run at once here, plus a reviewer.

Roles use the #112 names, which #107 adopts before its merge.

The registry comes first because every later slice stores into it. Reports come before wakes so that a wake can point at the digest instead of carrying text. GitHub events come before start and cleanup because cleanup is triggered by the merge event. Each slice is usable on `dev` when merged: after slice 1 bookkeeping survives a restart, after slice 3 the orchestrator stops polling.

## Single-owner rules

Every implementing pass keeps these. A slice that needs to break one updates this list first.

- **Worker bookkeeping** (owner, role, issue, branch, worktree, pull request, state, report, question, pending events, lab lease): `orchestration/registry-store.js` only. Nothing else writes the file, and no code reads the #107 child entries after the import.
- **Live state:** the daemon's live runtime state, run start, retry state and pending extension dialogs, as #107's `getSessionState` already reads them. Never the registry, never history.
- **Tool contracts:** `orchestration/tool-contracts.js`. Adapters project them; a tool's description and parameters live nowhere else.
- **Waking an orchestrator:** `orchestration/event-bus.js` only. No other code sends a custom message to an orchestrator.
- **Detecting session trouble:** `orchestration/watchdog.js`. **Detecting pull request changes:** `orchestration/github-watch.js`. Both only emit to the bus.
- **GitHub access:** `packages/web/server/lib/github`; the orchestration code calls it and never runs `gh` itself.
- **Command classification** (build, test, install, lab): one pure function in `orchestration/activity.js`, used by the digest, the gate and the lab guard.
- **Settings:** `settings-store.js` under `orchestration`, read through `createOrchestrationSettingsReader`.

End state: the orchestration module reads as if designed with a registry from the start; no adapter keeps the #107 child entries or the result message alive after slice 3.

## Known traps

| Trap | Slice |
|---|---|
| `childRecordsOf` in `orchestration-service.js` reads the parent JSONL for limits, stop and delivery; all three move to the registry together, or limits and delivery disagree. | 1 |
| `onSessionSettled` resolves the parent through the lineage entry; after a takeover the lineage still names the old orchestrator. | 1 |
| Sessions created by a #107 build have only JSONL child entries; the import must not duplicate a worker or revive a stopped one. | 1 |
| `pendingRuns` and `inflightSpawns` are in memory; after a restart a worker in `starting` must not count as busy forever. | 1, 7 |
| The owner can answer a worker in the UI, which goes through `sessions.prompt`, not `session_send`; the open question must clear on both. | 2 |
| Usage of a dormant worker is only in its JSONL; the digest must not activate four runtimes to sum tokens. Store a usage snapshot at each settle. | 2 |
| A disposed orchestrator is reopened through the session lease; `SESSION_IN_USE` from another daemon must keep the events pending, not drop them. | 3 |
| A Pi retry (`willRetry`) is not a failure; only exhaustion or a terminal error is. | 3 |
| A stalled run that later moves must not report "stalled" again for the same episode, nor stay silent for the next one. | 3 |
| The 400 `tool_result: all content must be type text if is_error is true` repeats on every message because the offending entry stays in the history; a plain retry cannot fix it. | 4 |
| `sessions.navigate` is an inline case in the daemon's IPC switch; the service must call the same code, so it moves into a function first. Navigating a busy session or one with a pending dialog must be refused, not raced. | 4 |
| `deleteSession` removes the JSONL; it must never run for a worker that is not the caller's or that still has a live run. | 7 |
| `os.freemem()` and `MemAvailable` may differ on Linux; the owner's threshold is `MemAvailable`. | 5 |
| `lab/run` locks `$XDG_RUNTIME_DIR` only for its own lifecycle and allows one pod per host; the lease guards workers, the pod check stays the hard stop for everything else. | 5 |
| The lab is offline: no GitHub and no real model. Lab proofs use #107's lab-only scripted provider and a lab-only GitHub source; product code has a seam, never a fake. | 3 to 8 |
| Squash merges leave the branch unmerged in git's eyes; `git branch --merged` cannot decide cleanup. | 7 |
| A dev daemon and the installed daemon have separate data directories, so separate registries, limits and lab leases. | 5 |

## Unknowns

| Unknown | Settled by | If it goes wrong |
|---|---|---|
| Whether #113 changes the service shape (for example adds an MCP adapter that needs the registry) before merge | start of slice 1 | adapt slice 1's seam; the registry stays daemon owned |
| Which entry is the last good one for the 400 (the parent of the assistant message whose tool call produced the error result, or an earlier one) | first step of slice 4, `debug` skill | the remedy stays report-only and `session_rewind` ships for the orchestrator to use by hand |
| Pi 1.1.0 extension `tool_call` can block a bash call with a reason | start of slice 5 | the lab guard becomes a refusal from `lab_acquire` plus the skill rule, and the PR says so |
| The GitHub module's credential and client functions run outside an HTTP request in the daemon process | start of slice 6 | a small IPC call from the web server to the daemon, with the server polling |
| Where `worker_start` puts worktrees (next to the caller's worktree, or a setting) | slice 7 plan review | a setting `orchestration.worktreeRoot` |
| A slice grows beyond about 700 review lines | before review | split it here first, then continue |
