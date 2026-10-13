# 0011. Fixed orchestrator: registry, wakes and proven-merge cleanup

- Status: Proposed
- Date: 2026-10-13
- Waits for: the owner confirms the design with the merge of #118

## Context

After #107 ([ADR 0010](0010-orchestration-through-daemon-tools.md)) an orchestrator could spawn workers but kept their bookkeeping in its own context, polled for results and cleaned up by hand. Epic #115 (parts #116 to #119) asked for one fixed orchestrator that is woken instead of polling, sees all workers in one digest, starts a worker for an issue and cleans up after the merge with one call each, and does no implementation work itself. The plan lived in a temporary spec folder ([ADR 0009](0009-spec-folder-for-multi-pr-features.md)), cut on 2026-10-12 under the owner rule "no overengineering" from ten slices to eight. This record keeps the decisions that still apply; the spec folder is deleted with #118.

## Decision

| # | Decision |
|---|---|
| O1 | One durable orchestration registry in the daemon (`<dataDir>/pi/orchestration-registry.json`, `orchestration/registry-store.js`, rules in `worker-registry.js`) owns worker ownership, bookkeeping, start operations with their reservations, reports and open questions. #107's JSONL child entries are imported once and not read again. |
| O2 | Live state is never stored; it comes from the daemon's live channels (runtimes, run start, retry state, pending dialogs). Facts that must survive disposal are snapshots written at settle and shown with their time; unknown is `null`. |
| O3 | A slot is a reservation taken in the registry update that checks the limit, before any side effect; `worker_start` reaches it through `session_spawn`. |
| O4 | One authorisation policy (`orchestration/policy.js`) decides every tool call from the caller's role and registry ownership. |
| O5 | Workers report through `worker_report`; a question closes only through a matching `resolves`. |
| O6 | Wakes (`orchestration/wakes.js`, the only way to wake an orchestrator) are kept in memory per worker and sent to the registry owner at send time, one `pichamber.orchestration.events` message per burst. A daemon restart drops queued wakes; the orchestrator reads the digest. |
| O7 | The watchdog is daemon code fed by the daemon's own events plus one 15 s tick, for registered workers only. |
| O8 | No automatic remedy: `session_rewind` is the orchestrator's tool, and the skill names the known provider 400 and how to rewind for it. |
| O9 | The worker limit counts reserved operations plus `starting` and `active` workers of the whole daemon. Spawning also refuses when the 1 minute load is above the core count or less than 8 GiB is available (`orchestration.gate`). |
| O10 | The lab has one holder: the checkout label `lab/run` puts on the pod, under its `flock`. A pod whose checkout directory is confirmed gone is abandoned and `down` or `up` from any checkout removes it. No lease file, no expiry, no daemon lease. |
| O11 | Pull request state for the watch is read by the web server through `lib/github` every 60 s, only while a watched worker exists, and diffed in the daemon (`orchestration/pr-watch.js`) with last seen values in memory; stale or partial reads emit nothing. |
| O12 | Owner rule: worktree, branch and worker session are removed only after a proven merge, decided by `orchestration/cleanup-guard.js` alone: a fresh `findPullForBranch` read with `mergedAt` set for exactly the worker's head branch, its head equal to the local tip, a clean worktree and no live run. Everything else removes nothing and returns the reason; `main`, `dev` and a main checkout never qualify. A helper is removed only if bound at spawn with `servesPr` to a pull request proven merged. |
| O13 | Squash is the normal merge. Cleanup order: `git worktree remove` (never `--force`), `git branch -D`, remote delete with a lease on the merged head, session last; each step is safe to repeat. Cleanup runs only when the orchestrator calls `worker_cleanup`, normally on `pr_merged`; on `pr_closed` it asks the owner. |
| O14 | Rewind and delete are tools of this epic, not of #107. There is no fork tool. |
| O15 | Worker guidance goes into the brief the service builds at spawn; orchestrator guidance into `instructions.js` and the `orchestrator` skill. |
| O16 | Orchestration switches live in `settings-store.js` under `orchestration`, each with default and bounds; no new UI. |
| O17 | GitHub access stays in `packages/web/server/lib/github`; orchestration code never runs `gh`. The merge lookup of `worker_cleanup` runs that module inside the daemon (it needs `gh` on PATH, not the HTTP server), so the merge proof is read right before removal and not handed over by the server. |
| O18 | Only a session marked as orchestrator orchestrates (#136): its id in `orchestration.orchestrators` of the settings sidecar, set in the file or with the one switch in the session's row menu (the only UI besides O16). A marked session gets the tools and `instructions.js`, workers and unmarked sessions get neither and the service refuses their orchestrator calls with `ORCHESTRATION_FORBIDDEN`. A worker stays a worker when marked. Wakes for an owner whose mark is gone wait in memory until it is marked again. |

## Consequences

- The orchestrator spends no tokens on polling and finds its workers after a compaction or restart through `session_list` and the digest.
- A daemon restart loses queued wakes and the watch's last seen values; the first read after a restart reports a final state once.
- Removal is never automatic. A refused cleanup leaves everything in place, and the owner decides about unmerged or changed work.
- Not built (cut on 2026-10-12): persisted event batches with acknowledgement, automatic rewind, a lab lease file, a paginated comment reader, a start journal and `worker_abandon`, automatic cleanup, a separate `session_delete`, an end to end recording.

## Revisit when

- An orchestrator acts on stale state after a daemon restart often enough that the owner notices (persisted wakes were cut).
- Removed work turns up missing: a cleanup ran although the work was not in the merged pull request.
- The owner wants workers removed without an orchestrator call, or another forge than github.com.
