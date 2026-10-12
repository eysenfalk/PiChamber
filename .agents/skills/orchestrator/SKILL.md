---
name: orchestrator
description: Use when this session orchestrates other PiChamber sessions through the `pichamber` orchestration tools, including spawning, briefing, following, steering or stopping worker sessions, running review rounds, checking host capacity before a spawn, picking the model role for delegated work, and cleaning up workers after a merge.
---

# PiChamber orchestrator

The orchestrator is the owner's session that turns the owner's requests into worker sessions, keeps them inside the repository workflow and reports back. It delegates implementation instead of doing it. The `pichamber` MCP tools (`mcp__pichamber__<tool>`) and the base orchestration instructions they inject on the first turn own the mechanics: idempotent retries with `clientRequestId`, bounded waits, what a review round carries. This skill adds the PiChamber practice. Read `docs/workflow.md` once per session; every worker follows it, and this skill does not restate it.

Order governs presentation, never disclosure: tell the owner about a blocker, risk or wrong assumption as soon as you see it.

## Workflow

1. **Take stock.** Call `orchestration_capabilities`, then `session_list`. Done when you know the role assignment, which sessions are your workers, and each worker's state, worktree and pull request.
2. **Choose the vehicle.** A blocking subagent makes the orchestrator deaf to the owner and hides the work from PiChamber. Use one only for short, self contained research or review whose result you consume right away. Anything longer, anything the owner should be able to open, and anything producing a worktree, branch or pull request is a worker session. Done when each piece of work has a vehicle.
3. **Check capacity** before every `session_spawn` (see Capacity). Done when the check passed, or the work is queued and the owner knows why.
4. **Prepare the worktree.** `git fetch origin`, then `git worktree add -b <issue>-<short-name> <path> origin/dev`, with `<path>` next to the existing worktrees (`git worktree list`). One worktree belongs to exactly one writing session; reviewers only read. Never reuse a worktree whose session still exists. Done when the path exists on a fresh branch.
5. **Spawn and brief.** `session_spawn` in that worktree with the role's model and thinking level (see Models), a title naming the issue, and a brief from [references/briefs.md](references/briefs.md). Done when you hold the returned `sessionId` and the brief names goal, issue, worktree, limits, acceptance, the workflow step to stop at, and the report format.
6. **Follow.** A child's result arrives on its own as a `pichamber.orchestration.result` message; do not poll. Use `session_read` to look inside a worker and `session_wait` only for a wait you actually need. Check every result against the brief's acceptance (diff, CI, proof) before you relay it; a worker's claim is not evidence. Done when each result is accepted with evidence or answered with a correction.
7. **Review.** Each review round is a new `review` session, never the author's session and never a reused reviewer. Corrections go to the author's own session with `session_send`. Done when the reviewer reports no blocking finding, or the owner decided the remaining ones.
8. **Report and clean up.** Tell the owner what is done, the proof, and what waits for them (plan approval, ready, merge). After the owner merged, clean up (see Cleanup). Done when the owner has the report and no merged worker is left behind.

## Owner input

- Pass on an approval only when the owner gave it in this session. Quote it word for word in the message to the worker and say what it covers. Approval to implement does not cover ready, merge, or pushes to `main` or `dev`.
- A worker's question or permission prompt goes to the owner. Answer it yourself only when the owner already decided that point in this session, and quote the decision.
- An owner idea that is not current work becomes a GitHub issue placed per the workflow, not a worker.
- Corrections go to an idle worker as a new prompt. Interrupt (`session_interrupt`) or steer a running worker only when its current work would otherwise be wasted.
- `session_send` and `session_interrupt` also reach sessions you did not spawn, such as the owner's own. Touch those only when the owner asks. `session_stop` stops a session and its descendants and works only on your own.

## Capacity

The tools refuse a fifth unfinished child in one orchestrator tree; that is the owner's limit of four workers. The host can run out before that, and other sessions of the owner load it too.

Before every spawn, measure: `nproc`, the 1 minute load (first field of `/proc/loadavg`) and `MemAvailable` in `/proc/meminfo`. Do not spawn while the load exceeds the core count or less than 8 GB are available (owner decision). Queue the work, tell the owner, and measure again when a worker finishes.

Look at what the running workers do. Builds and full test runs of several workers are staggered, not started together. The lab (`lab/run`) is one pod per host, so one worker at a time may use it; the brief says whether this worker may.

## Models

`orchestration_capabilities` returns the model and thinking level per role from the PiChamber settings; the owner changes the assignment there, and the values live only there. Spawn with the assigned model and level. Never write a model id into a brief or spawn from memory, and never substitute a model when an assignment is unavailable: report it to the owner. An explicit owner choice for one task wins over the role.

Pick the role by the work, not by the model you would like:

- `plan`: architecture, spec, plan, hard debugging.
- `implement`: multi step implementation in a worktree, large refactorings, work likely to run longer than about 30 minutes.
- `task`: clearly scoped everyday work such as a bug fix, a small feature, docs, or catching up tests.
- `research`: codebase or web research, comparison, summary with sources; changes nothing.
- `small`: short and mechanical, such as searching, renaming, summarizing, classifying.
- `review`: every review round on any worker's work, in a fresh session. It stays `gpt-6.1-sol` at `high` whichever model did the work (owner decision); if the settings say otherwise, tell the owner.

When `task` or `small` work turns out harder than briefed, escalate instead of letting the worker guess on: hand it to a new spawn one thinking level up or in the next role, and tell the owner. The brief asks the worker to report `QUESTION` in that case.

The defaults follow Anthropic's guidance as of October 2026 on choosing a model (https://platform.claude.com/docs/en/about-claude/models/choosing-a-model) and on effort levels per model (https://platform.claude.com/docs/en/build-with-claude/effort). Revisit the roles when new models arrive or the owner's enabled models change.

## Cleanup

After the owner merged a worker's pull request, remove what the worker leaves. Only for workers this orchestrator spawned; never `main`, `dev`, or a worktree of another session.

1. Confirm: `gh pr view <n> --json state,headRefOid` shows `MERGED`, `git -C <path> status --porcelain` is empty, and the branch tip equals `headRefOid`. Squash merges leave the branch unmerged in git's eyes, so `git branch --merged` cannot decide this. Anything else (dirty tree, commits after the merged head, a pull request closed without merge): stop and ask the owner.
2. Stop the session with `session_stop` if it still runs, then delete it.
3. `git worktree remove <path>` without `--force`, `git branch -D <branch>`, and `git push origin --delete <branch>` if the remote branch still exists.

Done when `git worktree list`, `git branch` and `session_list` no longer show the worker.

## Without the tools

If the `pichamber` tools do not show up, make one direct call to `mcp__pichamber__orchestration_capabilities`. If that fails too, stop and tell the owner. Do not drive `/api/pi/*` by hand with a token: the credential would end up in tool calls and transcripts.
