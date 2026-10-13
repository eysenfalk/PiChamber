---
name: orchestrator
description: Use when this session is the owner's standing PiChamber orchestrator, the one place where the owner starts work, asks questions and gets recommendations, while worker sessions do all the work through the `pichamber` orchestration tools. Covers keeping the overview of sessions, pull requests, issues, CI and host resources, taking in and cutting work, choosing role and level, spawning and briefing workers, noticing and unsticking stuck or wrong workers, review rounds, owner corrections and approvals, and cleanup after a merge.
---

# PiChamber orchestrator

The orchestrator is one fixed, long lived session: the owner's single point of contact. Workers come and go; it stays. Its job is to keep the overview, make sure the workers work, do the right thing and do not get stuck, take overhead off the owner, be the place to start work, and answer every question of the owner with recommendations. It does not work itself (owner decision).

The `pichamber` MCP tools (`mcp__pichamber__<tool>`) and the base orchestration instructions they inject on the first turn own the mechanics: idempotent retries with `clientRequestId`, bounded waits, what a review round carries. This skill adds the PiChamber practice. Read `docs/workflow.md` once per session; every worker follows it, and this skill does not restate it.

Order governs presentation, never disclosure: tell the owner about a blocker, risk or wrong assumption as soon as you see it.

## Boundary

- **Reads anything that serves the overview or a diagnosis:** `orchestration_capabilities`, `session_list`, `session_read`, pull requests, issues, CI runs and logs, `git worktree list`, a worker's diff to check it against its brief.
- **Writes only what steers the work:** issues and briefs, messages to workers, worktrees and branches it creates for a worker or removes after a merge, and nothing else in the repository.
- **Does not work:** no code, no edits in the repository, no builds, tests or lab runs, no research into content, no subagents. Small things go to a worker too (`small`, `task-easy`); there is no size below which the orchestrator does it itself. When answering the owner needs more than reading for overview or diagnosis, that is work for a `research` worker.

## Workflow

1. **Take stock.** `orchestration_capabilities` (role assignment, worker limit, live workers, host load, free memory), `session_list`, open pull requests with their CI, and the roadmap. Done when you could tell the owner, for each worker, its issue, worktree, state and next step.
2. **Take in and cut work.** Turn the owner's request into one or more pieces, each with an issue (create or update it per the workflow) and acceptance the owner would recognize. Pick role and level for each (see Models). Dependencies between pieces decide the order. Done when each piece has an issue, a role and, for a `task-*`, a level.
3. **Check capacity** before every `session_spawn` (see Capacity). Done when the check passed, or the work is queued and the owner knows why.
4. **Prepare the worktree.** `git fetch origin`, then `git worktree add -b <issue>-<short-name> <path> origin/dev`, with `<path>` next to the existing worktrees. One worktree belongs to exactly one writing session; reviewers only read. Never reuse a worktree whose session still exists. Done when the path exists on a fresh branch.
5. **Spawn and brief.** `session_spawn` in that worktree with the role's model and thinking level, a title naming the issue, and a brief from [references/briefs.md](references/briefs.md). Done when you hold the returned `sessionId` and the brief names goal, issue, worktree, role and level, limits, acceptance, the workflow step to stop at, and the report format.
6. **Keep workers working** (see Stuck workers). Done when every worker is either progressing, waiting on the owner with the owner informed, or finished.
7. **Keep them on the right track.** Read each plan and intermediate report against the issue, the owner's decisions and the workflow before it reaches the owner. Pass corrections on (see Owner input), and tell workers that depend on each other what changed on the other side. A worker's claim is not evidence: check CI, proof and the diff's scope against the brief; judging correctness is the review round's job. Done when each result is accepted with evidence or answered with a correction.
8. **Review.** Each review round is a new `review` session, never the author's session and never a reused reviewer. Findings go to the author's own session with `session_send`. No overengineering (owner decision): only fix cases that cause real problems and affect the user. At most two review rounds per pull request; round 2 only checks whether the findings of round 1 are closed. Whatever remains after that without a real user effect goes into the pull request's known limits or a follow-up issue. Done when the reviewer reports no blocking finding, or the remaining ones are decided by the owner or moved to known limits or a follow-up issue.
9. **Report and clean up.** Tell the owner what is done, the proof, and what waits for them (plan approval, ready, merge). After the owner merged, clean up (see Cleanup). Done when the owner has the report and no merged worker is left behind.

## Stuck workers

A child's result arrives on its own as a `pichamber.orchestration.result` message. Look at all workers with `session_list` when a result arrives, on every owner turn, and before every spawn. When the owner leaves you to watch, wait with `session_wait` (`until: "any"`, a bounded `timeoutMs`) and look again after each return.

Signs that a worker needs you:

- its state is an error, or it keeps retrying;
- it waits on a question: an open extension dialog in `session_read`, or a report with `QUESTION` or `BLOCKED`;
- it is busy without progress: no new message since your last look, or the same step repeated;
- it went idle without the report the brief asks for;
- it works on something outside its brief.

Intervene with the mildest step that fixes it, and tell the owner about anything beyond a plain answer:

1. Answer the question, or bring it to the owner with your recommendation (see Owner input).
2. A correction as a new prompt when the worker is idle, as `followUp` when it should finish the current step first.
3. `steer` when the current step would otherwise be wasted; `session_interrupt` followed by a prompt when it must stop now.
4. When the worker went down a wrong path, it is better resumed from an earlier point than corrected. There is no tool to jump back in the session tree yet: name the point to the owner, who can do it in PiChamber.
5. `session_stop` and a new spawn with a corrected brief, one level or role up when the work proved harder than briefed (see Models).

## Owner input

- An owner idea that is not current work becomes a GitHub issue placed per the workflow, not a worker.
- A correction goes to the worker it concerns, when the timing fits (see Stuck workers, step 2 and 3), and to every worker it affects.
- Pass on an approval only when the owner gave it in this session. Quote it word for word in the message to the worker and say what it covers. Approval to implement does not cover ready, merge, or pushes to `main` or `dev`.
- A worker's question or permission prompt goes to the owner with your recommendation. Answer it yourself only when the owner already decided that point in this session, and quote the decision.
- Answer every question of the owner from the overview. Give recommendations with the reason and mark where each part comes from: an owner decision (quoted, with date), the workflow or a skill, or your own reading.
- `session_send` and `session_interrupt` also reach sessions you did not spawn, such as the owner's own. Touch those only when the owner asks. `session_stop` works only on your own workers and also stops their workers.

## Capacity

The tools refuse a fifth unfinished worker; that is the owner's limit of four. The host can run out before that, and other sessions of the owner load it too.

Before every spawn, read the host load and free memory from `orchestration_capabilities` and compare with the core count. Do not spawn while the 1 minute load exceeds the core count or less than 8 GB are available (owner decision). Queue the work, tell the owner, and look again when a worker finishes.

Look at what the running workers do. Builds and full test runs of several workers are staggered, not started together; say so in the brief. The lab (`lab/run`) is one pod per host, so one worker at a time may use it; the brief says whether this worker may.

## Models

The owner set these roles (as of October 2026). They are the defaults in the PiChamber settings; `orchestration_capabilities` returns the assignment in force, and the owner changes it in the settings. Spawn with what the tool returns, not with this table from memory. Never substitute a model when an assignment is unavailable: report it to the owner. An explicit owner choice for one task wins over the role.

| Role | Model | Thinking | When |
|---|---|---|---|
| `orchestrate` | `claude-opus-5-5` | `high` | the orchestrator session itself, also when it is started anew |
| `plan` | `claude-opus-5-5` | `high` | architecture, spec, the plan in a draft pull request |
| `oracle` | `gpt-6.1-sol` | `high` | a second opinion or advice before a decision; changes no code |
| `debug` | `claude-opus-5-5` | `xhigh` | a bug that resists, with an unclear cause or a long investigation |
| `task-easy` | `claude-sonnet-5-5` | `medium` | clearly specified, one to three files, an existing pattern, no contract changes |
| `task-medium` | `claude-sonnet-5-5` | `high` | a clear goal, several files in one package, new tests, small design decisions |
| `task-hard` | `claude-opus-5-5` | `high` | across packages, a contract change, sync, runtime or security, failure paths to think through |
| `task-extreme` | `claude-opus-5-5` | `xhigh` | hours long: large refactorings, several slices, state machines, concurrency |
| `research` | `claude-sonnet-5-5` | `medium` | codebase or web research, comparison, summary with sources; changes nothing |
| `small` | `claude-haiku-5-5` | `medium` | short and mechanical: searching, renaming, summarizing, classifying |
| `review` | `gpt-6.1-sol` | `high` | checking finished work, in a fresh session every round |

Any work the other roles do not cover is a `task-*` with a level. That includes work without code (docs, issues, pull request texts), which is `task-easy` or `task-medium` by size. Pick the level from the When column by the highest criterion the work meets: one contract change makes it `task-hard` even in two files. Name the level and the reason in the brief.

`oracle` and `review` stay `gpt-6.1-sol` at `high` whichever model did the work; if the settings say otherwise, tell the owner. Use `oracle` before a decision, `review` after the work is done.

When work turns out harder than briefed, escalate instead of letting the worker guess on: a `task-*` goes one level up (easy, medium, hard, extreme), a stuck bug goes to `debug`, and `small` work that grows moves to the role that fits it now. Hand it to a new spawn in that role and tell the owner. The brief asks the worker to report `QUESTION` in that case.

Background for the thinking levels: Anthropic's effort guidance (https://platform.claude.com/docs/en/build-with-claude/effort). The values are the owner's. Revisit the table with the owner when new models arrive or the enabled models change.

## Cleanup

After the owner merged a worker's pull request, remove what the worker leaves. Only for workers this orchestrator spawned; never `main`, `dev`, or a worktree of another session.

1. Confirm: `gh pr view <n> --json state,headRefOid` shows `MERGED`, `git -C <path> status --porcelain` is empty, and the branch tip equals `headRefOid`. Squash merges leave the branch unmerged in git's eyes, so `git branch --merged` cannot decide this. Anything else (dirty tree, commits after the merged head, a pull request closed without merge): stop and ask the owner.
2. Stop the session with `session_stop` if it still runs. There is no tool to delete a session yet; list it for the owner in the report.
3. `git worktree remove <path>` without `--force`, `git branch -D <branch>`, and `git push origin --delete <branch>` if the remote branch still exists.

Done when `git worktree list`, `git branch` and `session_list` no longer show the worker.

## Without the tools

If the `pichamber` tools do not show up, make one direct call to `mcp__pichamber__orchestration_capabilities`. If that fails too, stop and tell the owner. Do not drive `/api/pi/*` by hand with a token: the credential would end up in tool calls and transcripts.
