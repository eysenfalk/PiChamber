# 115. Fixed orchestrator

Temporary spec for #115 with its parts #116, #117, #118 and #119 ([ADR 0009](../../docs/adr/0009-spec-folder-for-multi-pr-features.md)). The last pull request of the feature (slice 8) deletes this folder after moving what must last into `packages/web/server/lib/pi/session-daemon/DOCUMENTATION.md`, the `orchestrator` skill, `lab/README.md` and a decision record.

## Next agent prompt

Status 2026-10-12: slice 1 built (PR #125), slice 2 built (PR #127, stacked on #125). Slices 3 to 10 of the reviewed plan were cut to six slices under the owner rule "no overengineering": build only what solves a real problem the owner has, at most two review rounds per pull request, the second only on findings of the first. Slice files 1 and 2 still use the old numbers: old 3 and 4 are now 3, old 5 is 4, old 6 is 5, old 8 is 6, old 7 stays 7, old 9 and 10 are 8.

You are picking up the fixed orchestrator. Read this README, then the slice file of your slice, then `AGENTS.md`, `docs/workflow.md`, `packages/web/server/lib/pi/session-daemon/DOCUMENTATION.md` and every project skill the slice names. One branch and one draft pull request per slice, based on `origin/dev` once the slices it depends on are merged (slices 1 and 2 stack on #113 until it merges, as their pull requests say). Build the slice's contract and its tests; the "Bewusst nicht gebaut" list of each slice is binding, so a reviewer finding that asks for one of those items is answered with that list, not with code. Do not implement before the plan of your slice's pull request is approved.

Next pickup: [slice 3, Wakes and watchdog](slices/3-wakes-watchdog.md), [slice 5, Host gate](slices/5-host-gate.md) and [slice 6, Worker start](slices/6-worker-start.md), in parallel, once slice 2 is merged.

Roles are the eleven confirmed by the owner: `orchestrate`, `plan`, `oracle`, `debug`, `task-easy`, `task-medium`, `task-hard`, `task-extreme`, `research`, `small`, `review`.

Global TODO:

- [ ] [1 Registry, reservation and takeover](slices/1-registry.md) (part of #118), `task-hard`, built in #125
- [ ] [2 Worker reports and digest](slices/2-reports-digest.md) (part of #117), `task-hard`, built in #127
- [ ] [3 Wakes and watchdog](slices/3-wakes-watchdog.md) (closes #117, part of #116), `task-hard`
- [ ] [4 Rewind](slices/4-rewind.md) (closes #116), `task-medium`
- [ ] [5 Host gate and lab holder](slices/5-host-gate.md) (part of #119), `task-medium`
- [ ] [6 Worker start](slices/6-worker-start.md) (part of #118), `task-hard`
- [ ] [7 Pull request watch](slices/7-pr-watch.md) (closes #119), `task-medium`
- [ ] [8 Cleanup and close out](slices/8-cleanup-close-out.md) (closes #118 and #115, deletes this folder), `task-hard`

When you finish a slice: check its box, update the status line and the next pickup, and correct anything in this spec the work proved wrong, in the same pull request.

## Goal

One fixed orchestrator keeps the workers going and spends few tokens doing it. It is woken when a worker finishes, asks, fails or stalls, or when its pull request changes; it sees every worker in one compact digest; its bookkeeping lives in PiChamber, not in its context; starting a worker for an issue and cleaning up after the merge are one call each. The orchestrator itself does no implementation work.

Non goals: worker depth beyond 1, token or cost budgets, automatic remedies, automatic cleanup, the decision inbox (#87), an orchestrator view (#20), new session states in the UI (#106), a settings UI for the new switches, lab recordings for daemon behaviour, a new dependency.

## Cut of 2026-10-12

| Old slice | New | Reason |
|---|---|---|
| 3 Event bus | merged into 3 | An in-memory queue routed to the registry owner at send time wakes the orchestrator; batch ids, acknowledgement, owner generations and the takeover lock guarded crash races that cost one duplicate or one missed wake, and the digest covers both. |
| 4 Watchdog and lab proof base | merged into 3 | Detection is a small part of the wake path; the lab scripted provider, seed remote and tours were infrastructure for recordings that the faux provider e2e replaces. |
| 5 Rewind and safe remedy | 4 Rewind | The wake brings the failure to the orchestrator within seconds, so a manual `session_rewind` solves the stuck worker without a reproduction study and a safety classifier. |
| 6 Resource gate and lab lease | 5 Host gate and lab holder | `flock` plus the pod's checkout label already give the lab one holder; only a holder whose worktree is gone was a real block, and the command classifier added nothing the load numbers do not show. |
| 7 GitHub events | 7 Pull request watch | CI result, merge and close from the existing reader plus comment counts are what the orchestrator acts on; the paginated comment reader and persisted cursor were for exactly once comment events nobody needs. |
| 8 Worker start | 6 Worker start | One synchronous call that reuses what exists keeps the one-call start; the step journal, `start_failed` events and `worker_abandon` handled cases the orchestrator sees directly in the tool result. |
| 9 Cleanup and delete | merged into 8 | One `worker_cleanup` tool the orchestrator calls after `pr_merged`, behind the merge guard, keeps the owner rule; automatic cleanup, the journal and a separate `session_delete` were extra paths to the same result. |
| 10 End to end and close out | merged into 8 | No new behaviour: each slice proves its part, and moving the documentation fits into the last slice. |

Size of slices 3 to 10: before 2 750 to 4 150 lines in eight pull requests, after 1 450 to 2 200 lines in six.

## Proposed issue changes

For the orchestrator to decide; this plan does not edit issues.

- #116: "Known failures with a safe remedy are handled automatically" becomes: a failure wakes the orchestrator with the error line, and `session_rewind` lets it move the worker back. Done when: the lab criteria become a daemon e2e test with the faux provider; the remedy is the manual rewind in that test.
- #117: "the lab shows a worker reporting" becomes the faux provider e2e plus one screenshot of the events message.
- #118: "removed unless the owner switched that off" becomes "removed by one orchestrator call after the proven merge"; "in the lab" becomes tests with a temp repository and a bare remote.
- #119: the lab lock is the existing pod holder, released by `down` or when the holder's worktree is gone, with no timeout; "which workers are building, testing or using the lab" becomes host load and memory in the digest plus `lab/run status`; "review comments" become comment count changes; the lab refusal is shown in a host terminal transcript, because the lab container has no podman.

## Decisions

Taken by this plan. The owner can overturn any of them; each names the slice that depends on it.

| # | Decision | Slice |
|---|---|---|
| O1 | One durable **orchestration registry** in the daemon (`<dataDir>/pi/orchestration-registry.json`). It owns worker ownership, bookkeeping, start operations with their reservations, reports and open questions. #107's JSONL child entries are imported once. | 1 |
| O2 | Live state is never stored; it comes from the daemon's live channels. Facts that must survive disposal are snapshots written at settle and shown with their time; unknown is `null`. | 1, 2 |
| O3 | A slot is a reservation taken in the registry update that checks the limit, before any side effect. `worker_start` reaches it through `session_spawn`. | 1, 6 |
| O4 | One authorisation policy decides every tool call from the caller's role and registry ownership. | 1 |
| O5 | Workers report through `worker_report`; a question closes only through a matching `resolves`. | 2 |
| O6 | Wakes are kept **in memory** per worker and sent to the registry owner at send time, one `pichamber.orchestration.events` message per burst. A daemon restart drops queued wakes; the orchestrator reads the digest after a restart. #107's result message goes away. | 3 |
| O7 | The watchdog is daemon code fed by the daemon's own events plus one 15 s tick, for registered workers only. | 3 |
| O8 | **No automatic remedy.** `session_rewind` is the orchestrator's tool; the skill names the known 400 and how to rewind for it. | 4 |
| O9 | The worker limit counts reserved operations plus `starting` and `active` workers of the whole daemon. Spawning also refuses when the 1 minute load is above the core count or less than 8 GiB is available. | 1, 5 |
| O10 | The lab has one holder: the checkout label `lab/run` already puts on the pod, under its `flock`. A pod whose checkout directory is gone counts as abandoned. No lease file, no expiry, no daemon lease. | 5 |
| O11 | Pull request state is read in the daemon through `lib/github`, every 60 s, only for registered pull requests, with last seen values in memory; stale reads emit nothing. | 7 |
| O12 | Owner rule (R3-B1): worktree, branch and worker session are removed only after a proven merge, proved by a fresh `findPullForBranch` result with `mergedAt` set for exactly this head branch, no open pull request, its head equal to the local tip, a clean worktree and no live run. Everything else removes nothing. A helper session is removed only if bound at spawn with `servesPr` to a pull request proven merged. | 8 |
| O13 | Squash is the normal merge. Cleanup order: worktree remove (never `--force`), `git branch -D`, remote delete with an expected SHA lease, session last; each step safe to repeat. Cleanup runs only when the orchestrator calls `worker_cleanup`. | 8 |
| O14 | Rewind and delete are tools of this epic, not of #107. No fork tool. | 4, 8 |
| O15 | Worker guidance goes into the brief the service builds at spawn; orchestrator guidance into `instructions.js` and the skill, updated by each slice for the tools it adds. | 1 to 8 |
| O16 | New switches live in `settings-store.js` under `orchestration`, each with default, bounds and a round trip test; no new UI. | 3 to 7 |

Rejected: stacking every slice on `107-orchestration-mcp`; bookkeeping in the orchestrator's JSONL; polling `gh` from the orchestrator; a separate watchdog process; one follow-up per event. Cut on 2026-10-12 (see above): persisted event batches with acknowledgement, automatic rewind, the lab lease file, the paginated comment reader, the start journal and `worker_abandon`, automatic cleanup, the end to end recording.

## Ladder

```text
1 registry ─► 2 reports+digest ─┬─► 3 wakes+watchdog ─┬─► 4 rewind ────────┐
                                │                     └─► 7 PR watch ──────┤
                                ├─► 5 host gate ─────────► (7)             ├─► 8 cleanup+close out
                                └─► 6 worker start ────────────────────────┘
```

| Slice | Depends on | Parallel with | Role | Size |
|---|---|---|---|---|
| 1 | #113 | none | `task-hard` | built |
| 2 | 1 | none | `task-hard` | built |
| 3 | 2 | 5, 6 | `task-hard` | 400 to 550 |
| 4 | 3 | 5, 6, 7 | `task-medium` | 150 to 250 |
| 5 | 2 | 3, 4, 6 | `task-medium` | 150 to 250 |
| 6 | 2 | 3, 4, 5, 7 | `task-hard` | 250 to 400 |
| 7 | 3, 5 | 4, 6 | `task-medium` | 200 to 300 |
| 8 | 4, 6, 7 | none | `task-hard` | 300 to 450 plus moved docs |

Wakes come first after the digest because rewind and the pull request watch deliver through them. Slice 7 waits for slice 5 only because it closes #119, whose other half is slice 5. Slice 8 is last because it closes the epic and deletes this folder. At most three implementation workers run at once (3, 5, 6), plus a reviewer. Shared touch points are `tool-contracts.js`, `settings-store.js`, `instructions.js` and the skill; whoever merges second rebases on `dev`.

## Issue closing

| Issue | Closed by | Proof there |
|---|---|---|
| #117 reports and digest | slice 3 | faux provider e2e: a report wakes the orchestrator, which reads the digest; screenshot of the events message |
| #116 wake and watchdog | slice 4 | e2e: the 400 wakes the orchestrator, `session_rewind` gets the worker going |
| #119 resources, lab, GitHub | slice 7 | gate tests and host transcript of slice 5, pull request watch tests |
| #118 registry and lifecycle | slice 8 | start and cleanup tests with a squash merge |
| #115 epic | slice 8 | all parts closed, this folder deleted |

## Shared contracts

| Contract | Owner module | Slice |
|---|---|---|
| Registry schema, reservation, takeover | `orchestration/registry-store.js`, `worker-registry.js` | 1 |
| Authorisation policy | `orchestration/policy.js` | 1 |
| `worker_report`, `orchestration_digest` | `orchestration/tool-contracts.js` | 2 |
| Wake event shape, queue, watchdog rules | `orchestration/wakes.js` | 3 |
| `session_rewind` | `orchestration/tool-contracts.js`, `navigateSession` | 4 |
| Host gate, lab holder | `host-info.js`, `lab/run` | 5 |
| `worker_start` | `orchestration/worker-start.js` | 6 |
| Pull request diff | `orchestration/pr-watch.js` over `lib/github` | 7 |
| Merge guard, `worker_cleanup` | `orchestration/cleanup-guard.js` | 8 |

## Single-owner rules

- **Worker bookkeeping:** `orchestration/registry-store.js` only. No code reads the #107 child entries after the import.
- **Live state:** the daemon's runtimes, run start, retry state and pending extension dialogs. Never the registry, never history.
- **Tool contracts:** `orchestration/tool-contracts.js`. **Permission:** `orchestration/policy.js`.
- **Waking an orchestrator:** `orchestration/wakes.js` only; the pull request watch emits into it.
- **GitHub access:** `packages/web/server/lib/github`; orchestration code never runs `gh`.
- **Lab holder:** `lab/run`.
- **Removal decisions:** `orchestration/cleanup-guard.js`.
- **Settings:** `packages/web/server/lib/pi/settings-store.js`.

## Known traps

| Trap | Slice |
|---|---|
| `onSessionSettled` resolves the parent through lineage; after a takeover lineage still names the old orchestrator. Resolve the owner from the registry at send time. | 3 |
| `await sendCustomMessage` can overlap a new emit; removing the whole queue after the send would drop it. | 3 |
| A Pi retry (`willRetry`) is not a failure. A stall is one event per episode. | 3 |
| `sessions.navigate` is an inline IPC case; it becomes a function before the service calls it. | 4 |
| The 400 `tool_result: all content must be type text if is_error is true` repeats on every request until the entry leaves the branch. | 4 |
| The lab server is limited to about 4 GiB, so the 8 GiB gate default refuses spawns inside the lab. | 5 |
| `lab/run status` prints the caller's path, not the holder's. | 5 |
| `lib/github` serves stale last-good data on rate limits and marks failed sections; neither is a fresh read. | 7, 8 |
| `findPullForBranch` returns an open pull request first, else only the latest closed one. | 8 |
| Squash merges leave the branch unmerged in git's eyes; `git branch -d` refuses. | 8 |

## Unknowns

| Unknown | Settled by | If it goes wrong |
|---|---|---|
| `lib/github` runs outside an HTTP request in the daemon process | start of slice 7 | the web server polls and passes reads over a daemon IPC op |
| The lab seed can hold an orchestrator session for the screenshot | slice 3 | a screenshot of the message card rendered from a test fixture |
| A slice grows beyond its size estimate by half | before review | cut it back to its contract, not split it |
