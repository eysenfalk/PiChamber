# 0013. One pull request with slices, a draft at the first plan, a fast and a slow lane

- Status: Accepted
- Date: 2026-10-15

## Context

[ADR 0002](0002-workflow-from-jira-connector.md) made the draft pull request the plan, opened right after the branch, with nothing implemented before the owner approved it. [ADR 0009](0009-spec-folder-for-multi-pr-features.md) added a temporary `specs/<issue>-<name>/` folder for a feature delivered in several pull requests, because the plan of the later pull requests had no place before they existed.

Two things cost more than they bring:

- Every change waits for approval, also a bug fix with a red test or a one-slice change with clear criteria that the owner would approve without reading twice. The wait is only worth it where a wrong plan is expensive.
- A ladder of pull requests, each started by an agent that has not seen the conversation, needs a second place for the plan and a handoff text. A single description with slices holds the same plan, the squash commit keeps it, and nothing has to be deleted at the end.

The `forge-skills` package (`workflow` and `write-spec`) describes the flow the owner wants: explore first, open the draft at the first plan, name a plan lane, one pull request with slices. On 2026-10-15 the owner approved adopting it here as issue #182, with the template, the `pull-request` check and the branch scheme `<issue>-name` unchanged.

Alternatives considered:

- **Keep ADR 0009 and add lanes only:** leaves two places for a plan and a folder that someone must remember to delete.
- **No wait at all:** a one-way door or a contract change would reach code before the owner saw the plan.
- **Wait only for the owner in a fixed list of paths:** a path list says nothing about contracts or migrations and drifts.

## Decision

- **One pull request per undertaking, with slices.** The slices are items of the checklist under Acceptance criteria and ordered steps under Approach of the template. One slice is one commit, verified before the next. Each slice is reviewable on its own, roughly 100 to 600 lines (lock files and generated assets do not count). The pull request is squash merged, so `git log` on `dev` holds the whole plan.
- **Several pull requests only when a part must be live before the rest.** The later pull request is planned after the earlier one merged. There is no `specs/` folder; shared contracts and the handoff to the next agent go into the description of the pull request that needs them.
- **The draft pull request opens at the first plan.** Exploration before that is notes in an issue comment; there is no pull request yet. The plan names its lane.
- **Fast lane: build right away.** A bug fix with a red test first, or a one-slice change with clear acceptance criteria, no new dependency and no change to an external contract (API, persisted data, config format, visible UI behavior).
- **Slow lane: wait for the owner's go after the draft.** Everything else: several slices, an external contract, a migration or deletion, a new dependency, a one-way door, a product question, or questions left open by exploration. While waiting an agent may read, probe, prototype and write red tests for the wanted behavior, but writes no production code.
- **A worker may move a plan to slow, never to fast.** A fast plan that grows a second slice or touches a contract stops and moves to slow.
- **Unchanged:** the template and its sections, the `pull-request` check, the branch scheme, and the owner's word for ready, merge, pushes to `main` or `dev`, tags, releases and repository settings.

## Consequences

- A fast change reaches code without a pause; the draft pull request still exists before the first production commit and holds the plan.
- The description carries more than before in a large undertaking. A reviewer reads it by slice and by commit; resplitting means editing the description first.
- A reviewer can no longer find a ladder in a folder; history of a long plan is in the description and its edits.
- ADR 0009 is superseded. ADR 0011 and the earlier pull requests that mention the spec folder stay as history.
- The passages of ADR 0002 on approval before implementing and on starting every change with a draft pull request are superseded; the rest of ADR 0002 stays in force.
- The orchestrator brief no longer says "never implement before approval" unconditionally; it applies to the slow lane.

## Revisit when

Fast lane changes need a revert or rework more than once because the plan was wrong, one pull request with slices becomes too large to review by commit, or the tracker gains a versioned place for multi pull request plans.
