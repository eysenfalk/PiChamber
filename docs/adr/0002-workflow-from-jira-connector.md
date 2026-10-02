# 0002. Workflow from jira-connector: plans in draft pull requests, proof before merge

- Status: Accepted
- Date: 2026-10-02

## Context

On 2026-10-02 the user asked to work in this repository the way jira-connector (`d102/acsai/jira-connector`, `docs/workflow.md`, ADR 0009) and awx-analyzer (`FEysen/awx-analyzer`, `docs/workflow.md`) do: a draft merge request holds the plan, nothing is implemented before the plan is approved, and nothing is merged without proof, a recording or screenshots, that a reviewer can reproduce. jira-connector adapted awx-analyzer's workflow and added decision records, `CONTEXT.md`, the check of the whole description before the hand-over, and reproducible proof.

This repository differs from both:

- It lives on GitHub (`eysenfalk/PiChamber`, a fork of `RyderAsKing/PiChamber`), so tickets are GitHub issues and plans are pull requests.
- It is a Bun and TypeScript monorepo. The workflow tools of jira-connector are Python, those of awx-analyzer TypeScript run by Node.
- `AGENTS.md` forbade git and GitHub commands without an explicit request. The workflow needs agents to branch, push and open draft pull requests on their own.
- Its pull request template already asked for affected surfaces, the repository guidance applied, validation and visual evidence, but had no plan, no checklist and no approval step.
- It had no workflow run on the fork yet (`gh run list`, 2026-10-02), although Actions are enabled.

The user chose on 2026-10-02: squash merges only; decision records, `CONTEXT.md` and a feature map belong to the workflow; a podman sandbox is not needed now.

## Decision

- The workflow of jira-connector, described in `docs/workflow.md` and `AGENTS.md`, with tracker GitHub `eysenfalk/PiChamber` and plans in pull requests (`workflow.json`).
- The pull request template combines the sections of jira-connector with Affected surfaces and Repository guidance of this repository. A `pull-request` job checks every description against it on every change of the pull request.
- Agents may create and push branches and open and update draft pull requests in `eysenfalk/PiChamber` without asking. Implementing a plan, merging, pushing to `main`, tags and releases, repository settings and anything in an upstream repository need approval.
- Workflow tools and repository rules are JavaScript modules in `scripts/workflow/`, tested with `bun test` and run by `bun run test:repo`, which is part of `bun run test`. No new dependency.
- The repository allows only squash merges, the squash commit is the pull request title and description, and `main` has linear history.
- Proof recording and the feature map come in their own pull request. The podman sandbox and an English-only check are ideas in `ROADMAP.md`.

## Consequences

- Every change, including small fixes, starts with an issue and a draft pull request.
- `AGENTS.md`, `CONTRIBUTING.md` and the template differ from upstream; changes from upstream to these files need a manual merge.
- Until the proof tool exists, proof is recorded by hand, and where proof files live is open (`CONTEXT.md`).
- Required status checks can only be added once CI has run on the fork; until then the checks inform but do not block a merge.

## Revisit when

The fork contributes back to upstream, upstream adopts its own workflow, or the workflow tools grow beyond what plain modules and `bun test` carry.
