# 115. Fixed orchestrator

Temporary spec for #115 with its parts #116, #117, #118 and #119 ([ADR 0009](../../docs/adr/0009-spec-folder-for-multi-pr-features.md)). The last pull request of the feature deletes this folder after moving what must last into `packages/web/server/lib/pi/session-daemon/DOCUMENTATION.md`, the `orchestrator` skill, `lab/README.md` and a decision record.

## Next agent prompt

Status 2026-10-12: plan only, nothing implemented. Revised after two reviews on #120 (round 1: B1 to B6, S1 to S10; round 2: R2-B1 to R2-B4, R2-S1 to R2-S7); the plan waits for the orchestrator's approval in that pull request. Slice 1 needs #110 (PR #112) merged, because it is the first slice that edits the `orchestrator` skill, and it needs #107 (PR #113).

You are picking up the fixed orchestrator. Read this README, then the slice file of the next open slice, then `AGENTS.md`, `docs/workflow.md`, `packages/web/server/lib/pi/session-daemon/DOCUMENTATION.md` and every project skill the slice names. Work in one branch and one draft pull request per slice. Start a slice only after the slices it depends on (see Ladder) are merged into `dev`, and base it on `origin/dev`. The one exception is slice 1 and #113: if #113 is not in `dev` when slice 1 starts, slice 1 branches from `origin/107-orchestration-mcp`, its draft pull request targets `dev` and names #113 as the base it waits for, and it is rebased onto `dev` after #113 merges and before it leaves draft. Do not implement before the plan of your slice's pull request is approved.

Next pickup: [slice 1, Registry, reservation and takeover](slices/1-registry.md).

Blockers: none for slice 1 beyond #112. Roles are the eleven confirmed by the owner: `orchestrate`, `plan`, `oracle`, `debug`, `task-easy`, `task-medium`, `task-hard`, `task-extreme`, `research`, `small`, `review`. Compared revisions: #113 at `ff510a92` (`ORCHESTRATION_ROLES` in `settings-store.js:77`, enum in `orchestration/tool-contracts.js:52`) and #112 at `0c9683d9` (`.agents/skills/orchestrator/SKILL.md:71-87`) both use exactly these names. Slice 1 checks again that the merged state still does; if not, stop and report.

Global TODO:

- [ ] [1 Registry, reservation and takeover](slices/1-registry.md) (part of #118), `task-hard`
- [ ] [2 Worker reports and digest](slices/2-reports-digest.md) (part of #117), `task-hard`
- [ ] [3 Event bus](slices/3-event-bus.md) (part of #116), `task-hard`
- [ ] [4 Watchdog and lab proof base](slices/4-watchdog.md) (closes #117, part of #116), `task-hard`
- [ ] [5 Rewind and safe remedy](slices/5-rewind-remedy.md) (closes #116 only for a proven safe case), `task-hard` with `debug`
- [ ] [6 Resource gate and lab lease](slices/6-resource-gate-lab-lease.md) (part of #119), `task-hard`
- [ ] [7 GitHub events](slices/7-github-events.md) (closes #119), `task-hard`
- [ ] [8 Worker start](slices/8-worker-start.md) (part of #118), `task-extreme`
- [ ] [9 Cleanup and delete](slices/9-cleanup.md) (closes #118), `task-extreme`
- [ ] [10 End to end and close out](slices/10-close-out.md) (closes #115, deletes this folder), `task-medium`

When you finish a slice: check its box, update the status line and the next pickup, and correct anything in this spec the work proved wrong, in the same pull request.

## Goal

The orchestrator session works on events and digests instead of polling and raw transcripts. It is woken when a worker finishes, asks, fails or stalls, or when its pull request changes; it sees every worker in one compact call; its bookkeeping lives in PiChamber, not in its context; starting a worker for an issue and cleaning up after the merge are one call each. The orchestrator itself does no implementation work.

Non goals: worker depth beyond 1, token or cost budgets, the decision inbox (#87), an orchestrator view (#20), new session states in the UI (#106), a settings UI for the new switches, a new dependency.

## Decisions

Taken by this plan. The owner can overturn any of them; each names the slice that depends on it.

| # | Decision | Slice |
|---|---|---|
| O1 | One durable **orchestration registry** in the daemon, a JSON file next to the other PiChamber stores (`<dataDir>/pi/orchestration-registry.json`, per-file lock, atomic replace, one serialised `update`). It owns ownership of workers, their bookkeeping state, start operations with their reservations, reports, open questions and pending events. The parent's #107 JSONL child entries are imported once and then no longer read. The worker's own lineage entry stays: it marks a session as a worker and keeps sidebar nesting. | 1 |
| O2 | Live state (busy, idle, retry, waiting for input, running commands) is never stored. It comes from the daemon's live channels. Facts that must survive disposal (last progress, last error, usage total) are snapshots written at settle and shown with their time; a value the daemon does not know is `null`, never zero. | 1, 2 |
| O3 | A slot is a **reservation** taken in the same registry `update` that checks the limit, for `session_spawn` and `worker_start` alike, before any side effect. A start is a durable operation with a generated `opId` that may exist before its session (B1); `(orchestratorId, clientRequestId)` only looks it up and gets a second key on takeover (R2-S3). A worker stays `starting` until its session is on disk, so a crash before Pi writes the JSONL is resumed, not lost (R2-B1). | 1, 8 |
| O4 | One **authorisation policy** in the service decides every tool call from the caller's role (worker or orchestrator, by lineage) and registry ownership of the target, after schema validation and before any side effect. Inline and MCP adapters reach the same check; tool visibility is not a permission (S10). | 1 |
| O5 | Workers report through `worker_report` with the #112 status words. `done` needs a pull request or a stated reason for none, and evidence. A question has an id and closes only through a report or `session_send` with a matching `resolves`; a second question while one is open is refused unless it resolves the first (S1, R2-S1). | 2 |
| O6 | All wakes go through one **event bus** per orchestrator, delivered as one `pichamber.orchestration.events` message per burst. A delivery claims a batch with an id and acknowledges exactly that batch's events; an unclear send is resolved by looking for the batch id in the orchestrator's session before sending again. Claim, send and acknowledgement run under one in-process delivery lock per owner; takeover is refused while the old owner's lock is held, moves pending events, resolves a crashed in-flight batch against the old session before moving it, and bumps an owner generation, so an old sender can neither acknowledge nor deliver (B4, R2-B4). The per-settle `pichamber.orchestration.result` message of #107 goes away. | 3 |
| O7 | The **watchdog** is daemon code fed by the daemon's own events plus one 15 second tick, for registered workers only. Thresholds are settings. | 4 |
| O8 | **Auto rewind only for a proven safe case**: the failing assistant message has exactly one tool call, that tool is read-only, and nothing follows it. The worker is rewound to just before that message and told what went wrong; the original task is not sent again. Every other match is reported, and `session_rewind` is there for the orchestrator. #116's remedy criterion counts as met only for that case (B6). | 5 |
| O9 | The worker limit counts reserved operations plus `starting` and `active` workers of the whole daemon. A `done` report frees nothing until its run settles, and a new run of a `done` or `stopped` worker reserves at the daemon's one input path, for UI prompts and `session_send` alike (R2-B2). Spawning also refuses when the 1 minute load is above the core count or less than 8 GiB is available (`MemAvailable`), with the numbers in the reason; the check runs at reservation time. | 1, 6 |
| O10 | The **lab lease is enforced in `lab/run` itself**: a lease file under `$XDG_RUNTIME_DIR`, written under the existing `flock`, held by the checkout path that ran `up`. `up`, `down` and `record` from any other checkout are refused while it is valid, whether a worker, a second daemon or a person runs them; `lab/run lease break` is the owner's explicit override. After expiry, another checkout removes the old pod under the same lock before it starts; the lease is written only after `up` succeeded (R2-S4). The daemon only reads the file for the digest. No daemon lease and no lease tools (B5). | 6 |
| O11 | GitHub state of the workers' pull requests is read in the daemon through `packages/web/server/lib/github` and its normalised results, polled at most every 60 seconds, only for registered pull requests. Events come from a persisted cursor per pull request; new comments come from a paginated reader added to `lib/github` and a time cursor with a small overlap set (R2-S2); decisions that lead to an event or a cleanup need a fresh read without section errors (S4, S5). | 7 |
| O12 | One **deletion guard** (`orchestration/cleanup-guard.js`) decides every removal: cleanup after a merge, `session_delete` and `worker_abandon`. Removal after a merge needs pull request identity, `merged`, the merged head, local and remote tip equal to it, a clean worktree and no live run. A pull request missing from the registry is unknown, not absent: removal without one needs proof that none is open (remote branch authoritatively absent, or a fresh lookup of the head branch on GitHub) plus no commits beyond `origin/dev` and a clean worktree. No proof, no removal (B2, R2-B3). A remote branch already deleted after the merge counts as done, a failed remote lookup blocks (R2-S7). | 8, 9 |
| O13 | Squash is the normal merge. Cleanup order is worktree remove (never `--force`), `git branch -D` after the guard, remote delete with an expected SHA lease, and the session last, each step journalled and safe to repeat (B3). | 9 |
| O14 | Rewind and delete are tools of this epic, not of #107 (orchestrator decision 2026-10-12). Fork is not offered: it gives the worker a new session id, while navigate keeps the id and Pi's tree keeps the abandoned branch. | 5, 9 |
| O15 | Worker guidance (how to report, the lab rule) goes into the brief the service builds at spawn, because #107's extension injects base instructions only into orchestrators (S10). Orchestrator guidance goes into `instructions.js` and the skill, updated by each slice for the tools it adds. | 1 to 9 |
| O16 | New switches live in `packages/web/server/lib/pi/settings-store.js` under `orchestration`, each with normalisation, default, bounds, patch merge and a round trip test in the slice that adds it. The owner changes them through the settings route #107 already exposes; no new UI (S9). | 3 to 9 |
| Ladder | Ten pull requests on `dev`, ordered by the DAG below; only slice 1 may stack on #113, as described in the prompt. The spec pull request itself is docs only and based on `dev`. | all |

Rejected:

- **Stacking every slice on `107-orchestration-mcp`.** Every change there would force a rebase of all slices, and ADR 0008 has slices land on `dev`. Only slice 1 may stack, and only while #113 is open.
- **Keeping bookkeeping in the orchestrator's JSONL** (#107's choice): takeover would have to rewrite another session's log, and limits across trees would scan every orchestrator.
- **A daemon side lab lease with `lab_acquire` tools**: two daemons would hold two leases for one host lab, and a person or a session outside the registry would bypass it. The boundary is `lab/run` (B5).
- **A `tool_call` guard on `lab/run`**: not needed once `lab/run` enforces the lease itself.
- **Exactly once event delivery**: would need Pi to accept a message idempotently. A batch id plus a look into the orchestrator's session before resending is enough; a repeat is visible as the same batch id.
- **Rewind for every match of the 400**: may repeat file edits, commits or external calls of the dropped message (B6).
- **Polling `gh` from the orchestrator or a script**, **a separate watchdog process**, **one follow-up per event**.

## Ladder

```text
1 registry ─► 2 reports+digest ─► 3 event bus ─► 4 watchdog ─┬─► 5 rewind+remedy ──────────────────────────┐
                                                             └─► 6 gate+lab lease ─┬─► 8 worker start ─┐  ├─► 10 close out
                                                                                   └─► 7 GitHub events ─┴► 9 cleanup ┘
```

| Slice | Depends on | Parallel with | Role | Size guess |
|---|---|---|---|---|
| 1 | #112 merged; #113 merged or stacked; role names match | none | `task-hard` | 500 to 650; over 600, takeover becomes its own pull request first |
| 2 | 1 | none | `task-hard` | 350 to 500 |
| 3 | 2 | none | `task-hard` | 350 to 500 |
| 4 | 3 | none | `task-hard` | 400 to 600 |
| 5 | 4 | 6, 7, 8 | `task-hard` with `debug` | 250 to 450 |
| 6 | 4 | 5 | `task-hard` | 350 to 500 |
| 7 | 6 | 5, 8 | `task-hard` | 450 to 600 |
| 8 | 6 | 5, 7 | `task-extreme` | 400 to 600 |
| 9 | 7, 8 | 5 | `task-extreme` | 400 to 600 |
| 10 | 5, 9 | none | `task-medium` | 150 to 300 plus deletions |

All slices from 1 to 9 change a daemon contract, which #112 rates `task-hard` at least; start and cleanup delete or create git state and are `task-extreme`. Parallel slices own separate modules (`remedies.js`, `lab/run` and `activity.js`, `github-watch.js`, `worker-start.js`). Their shared touch points are `tool-contracts.js`, `settings-store.js`, `instructions.js` and the skill; whoever merges second rebases on `dev`. With the four-worker limit, at most three implementation workers run here at once, plus a reviewer.

The registry comes first because every later slice stores into it. Reports come before wakes so a wake can point at the digest. The bus comes before the watchdog so detection has one way out. The gate comes before start because start reserves through it, and before GitHub events because slice 7 closes #119 with slice 6's proofs (R2-S5). GitHub comes before cleanup because cleanup runs on `pr_merged` and asks GitHub for a pull request the registry does not know. Each slice is usable on `dev` when merged.

## Issue closing

An issue is closed by the pull request that delivers its last acceptance criterion with its proof (S7).

| Issue | Closed by | Proof there |
|---|---|---|
| #117 reports and digest | slice 4 | lab recording: a worker's report wakes the orchestrator, which reads only the digest |
| #116 wake and watchdog | slice 5 | lab recording of the safe remedy; if the reproduction finds no safe case, slice 5 does not close #116 and the orchestrator asks the owner about the criterion |
| #119 resources, lab, GitHub | slice 7, which merges only after slice 6 | lease tests and host transcript of slice 6 plus the `ci_passed` recording. The lab cannot run `lab/run` (no podman, read-only checkout), so the refusal is not a lab recording; assumption until the owner accepts it, raised by the orchestrator before slice 7 closes #119 |
| #118 registry and lifecycle | slice 9 | start and cleanup tests with a squash merge, cleanup recording |
| #115 epic | slice 10 | end to end recording |

## Shared contracts

The slice files hold the full shapes; this is the index.

| Contract | Owner module | Slice |
|---|---|---|
| Registry schema, state transitions, reservation, takeover | `orchestration/registry-store.js` | 1 |
| Authorisation policy | `orchestration/policy.js`, called by `orchestration-service.js` | 1 |
| `worker_report`, `orchestration_digest` | `orchestration/tool-contracts.js` | 2 |
| Event shape, batch, acknowledgement | `orchestration/events.js`, `orchestration/event-bus.js` | 3 |
| Watchdog rules | `orchestration/watchdog.js` | 4 |
| Lab proof fixtures (scripted provider, bare remote with `dev`, GitHub source, lab settings) | `scripts/lab/`, `lab/seed-manifest.json`, `scripts/proof/` | 4, extended by 7 to 10 |
| `session_rewind`, remedy table | `orchestration/remedies.js` | 5 |
| Lab lease file | `lab/run` | 6 |
| Pull request reader and cursor | `orchestration/github-watch.js` over `lib/github` | 7 |
| Start operation | `orchestration/worker-start.js` | 8 |
| Deletion guard and cleanup journal | `orchestration/cleanup-guard.js`, `orchestration/cleanup.js` | 9 |

## Single-owner rules

Every implementing pass keeps these. A slice that needs to break one updates this list first.

- **Worker bookkeeping** (owner, state, start operation, reservation, report, question, pending events, cursors): `orchestration/registry-store.js` only. No code reads the #107 child entries after the import.
- **Live state:** the daemon's runtimes, run start, retry state and pending extension dialogs (`extension-bridge.js`). Never the registry, never history. #107's `getSessionState` reports only id and streaming; the digest reads the rest from these owners.
- **Tool contracts:** `orchestration/tool-contracts.js`. **Permission:** `orchestration/policy.js`.
- **Waking an orchestrator:** `orchestration/event-bus.js` only.
- **Detecting session trouble:** `orchestration/watchdog.js`. **Detecting pull request changes:** `orchestration/github-watch.js`. Both only emit to the bus.
- **GitHub access:** `packages/web/server/lib/github`; orchestration code never runs `gh`.
- **Lab ownership:** `lab/run` and its lease file.
- **Removal decisions:** `orchestration/cleanup-guard.js`.
- **Command classification** (build, test, install, lab): one pure function in `orchestration/activity.js`.
- **Settings:** `packages/web/server/lib/pi/settings-store.js`, read through `createOrchestrationSettingsReader`.

End state: the orchestration module reads as if designed with a registry from the start; nothing keeps the #107 child entries or the result message alive after slice 3.

## Known traps

| Trap | Slice |
|---|---|
| `childRecordsOf` reads the parent JSONL for limits, stop and delivery; all three move to the registry together, or they disagree. | 1 |
| `onSessionSettled` resolves the parent through lineage; after a takeover lineage still names the old orchestrator. | 1 |
| `inflightSpawns` is in memory; a crash between session create and the registry write must not leave a second worker on retry. | 1, 8 |
| Pi writes a session's JSONL only with its first assistant message; a session created before a crash may not exist after restart. | 1, 8 |
| A `worker_report done` is a tool call inside a running turn; the turn can go on afterwards. | 1, 2 |
| `getPull` reads one page of reviews and capped threads and thread comments; it cannot feed the comment cursor. | 7 |
| `before_agent_start` in #107's extension returns early for workers; worker guidance in `instructions.js` never reaches them. | 1, 2 |
| The owner answers in the UI through `sessions.prompt`, which cannot name a question id; the question stays open until the worker reports. | 2 |
| Usage of a dormant worker is only in its JSONL; the digest must not activate runtimes to sum tokens. | 2 |
| `await sendCustomMessage` can overlap a new emit; clearing the whole pending list would drop the new event. | 3 |
| A disposed orchestrator is reopened through the lease; `SESSION_IN_USE` keeps the batch pending. | 3 |
| A Pi retry (`willRetry`) is not a failure. A stall is one event per episode. | 4 |
| #107 has a faux provider only in tests; the lab has no scripted provider yet. | 4 |
| The lab server is limited to about 4 GiB, so the 8 GiB gate default would refuse every spawn there. | 4, 6 |
| The 400 `tool_result: all content must be type text if is_error is true` repeats on every request until the entry leaves the branch. | 5 |
| `sessions.navigate` is an inline IPC case; it becomes a function before the service calls it. | 5 |
| `lab/run` locks `$XDG_RUNTIME_DIR` with `flock` but records no holder; `record` checks the pod's checkout label only after the pod exists. | 6 |
| `lib/github` serves stale last-good data on rate limits and marks failed sections in `sectionErrors`; neither is a fresh success. | 7 |
| Squash merges leave the branch unmerged in git's eyes; `git branch -d` refuses. | 9 |
| A dev daemon and the installed daemon have separate registries and limits; the lab lease is shared because it is on the host. | 1, 6 |

## Unknowns

| Unknown | Settled by | If it goes wrong |
|---|---|---|
| #113 changes the service shape before merge | start of slice 1 | adapt slice 1's seam; the registry stays daemon owned |
| A safe case for the 400 exists | first step of slice 5, `debug` skill | no auto remedy; `session_rewind` and detection ship, #116 stays open for the owner's call |
| `lib/github` runs outside an HTTP request in the daemon process | start of slice 7 | the web server polls and passes changes over a daemon IPC op; the mapping stays pure |
| Where `worker_start` puts worktrees | slice 8 plan review | a setting `orchestration.worktreeRoot` |
| No open pull request can have a head branch that is absent on the remote (GitHub closes it when the branch is deleted) | start of slice 8, GitHub docs and one manual check on a test branch | slice 8 refuses every branch removal and leaves it to slice 9's GitHub lookup |
| A slice grows beyond about 600 review lines | before review | split it here first, then continue |
