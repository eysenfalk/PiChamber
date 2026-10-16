# 0009. A feature delivered in several pull requests gets a temporary spec folder

- Status: Superseded by 0013
- Date: 2026-10-12

## Context

A pull request holds one plan of roughly 100 to 600 review lines (`docs/workflow.md`). The sidebar tree (#95 with #96 to #99) needs seven pull requests in a row, and each one is started by an agent that has not seen the conversation in which the design was settled. The decisions of that conversation existed only in chat, in a map under `/tmp` and in four draft plans, none of which survives a context cut or a new session.

On 2026-10-12 the owner chose, while grilling the spec for #95: the spec lives in the repository under `specs/95-workspace-tree/`, it is temporary, the last pull request of the feature deletes it, and the lasting reasons move into the module `DOCUMENTATION.md` and, where needed, a decision record. The same day the owner chose seven sequential, unstacked pull requests, each started after the previous one is merged into `dev` ([ADR 0008](0008-dev-integration-branch.md)).

`docs/workflow.md` says there is no archive of plans. A spec that stays after its feature shipped would be such an archive and would drift from the code.

Alternatives considered:

- **Plan only in each pull request description:** the next pull request does not exist yet when the first is planned, so the ladder, shared contracts and rejected alternatives have nowhere to live.
- **Plan in the parent issue:** issues are not versioned with the code, and a change of the ladder cannot be reviewed in the pull request that causes it.
- **Archive finished specs under `specs/done/`:** contradicts the rule that there is no archive of plans.

## Decision

- A feature that needs more than one pull request may get `specs/<issue>-<name>/` with a `README.md` (goal, ladder, single-owner rules, the handoff for the next agent) and one file per pull request under `slices/`.
- The spec changes in the pull request whose work changes it. Each pull request description links to its slice file instead of repeating it.
- The last pull request of the feature deletes the folder. Before that, it moves what must last into the owning `DOCUMENTATION.md` or a decision record.
- A single pull request never gets a spec folder; its plan is its description.

## Consequences

- A new agent starts a pull request of the feature from the spec's "Next agent prompt" without the conversation.
- Reviewers see changes to the ladder in the diff.
- The deletion is a step of the last slice; forgetting it leaves a stale plan, which the review of that pull request has to catch.
- First use: #95 shipped in seven pull requests (#100, #105, #109, #111, #114, #121 and the quick create pull request), and the last one moved the lasting reasons into `packages/ui/src/components/session/sidebar/DOCUMENTATION.md` and deleted `specs/95-workspace-tree/`.

## Revisit when

A spec folder outlives its feature, specs are written for single pull requests, or the tracker gains a place for multi pull request plans that is versioned with the code.
