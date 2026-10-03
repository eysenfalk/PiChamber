# Workflow

How work moves from an idea to `main` in this repository, who does what, and what is automated. It applies to people and agents alike. [AGENTS.md](../AGENTS.md) carries the short version, and [ADR 0002](adr/0002-workflow-from-jira-connector.md) says where this workflow comes from.

## Principles

1. **The code is the memory.** What the code, its tests and its types say is not written down a second time. Documents hold only what the code cannot: the shape of the system and its invariants (package `README.md` and module `DOCUMENTATION.md` files), decisions and their reasons ([docs/adr](adr/README.md)), and what is not settled yet ([CONTEXT.md](../CONTEXT.md)).
2. **Trust comes from verification.** Every change is proven: by tests, and for anything a user sees, by a recording or screenshots of the real program. Nobody has to take a claim on faith, including an agent's.
3. **Enforce rules as hard as possible.** First through the architecture (make the mistake impossible), then through tests and CI, then through instructions, and only last through review. When the same correction is needed twice, it becomes a test or a lint rule, not a new paragraph.

## Where things live

| Place | Holds | Written by |
|---|---|---|
| Code and tests | What the program does and the proof that it does it. Test names are sentences about behavior. | people and agents |
| Package `README.md` and module `DOCUMENTATION.md` | Runtimes, module ownership, contracts and invariants | by hand, in the pull request that changes them |
| [AGENTS.md](../AGENTS.md) and `.agents/skills/` | Always-on rules and routing; detailed workflows per kind of change | by hand |
| [docs/adr](adr/README.md) | One record per decision: context with evidence and sources, decision, consequences, when to revisit | by hand, in the pull request that makes the decision; superseded, not rewritten |
| [CONTEXT.md](../CONTEXT.md) | **Live context:** open findings and questions, each with source, date and what settles it | by hand; entries are added in the pull request that learns them and removed in the one that settles them |
| [Roadmap issue #24](https://github.com/eysenfalk/PiChamber/issues/24) | The order of upcoming work as its ordered sub-issues, a generated order list and graph, and ideas as one line each | sub-issues and ideas: people and agents; list and graph: `scripts/workflow/roadmap-sync.mjs` |
| GitHub issues | Roadmap items (label `roadmap`) and bugs: problem, requirements, acceptance | people and agents |
| Pull request | The plan (how), its proof, the review and the CI result | agent drafts, user approves |
| Git history on `main` | One squash commit per pull request, containing its title and full description | automatic |

There is no archive of plans and no hand-maintained catalogue. A fact is written in one place; anywhere else links to it. A feature map of what users can do, generated from acceptance tests through the lab, is a separate roadmap item after #11.

## Configuration: `workflow.json`

`workflow.json` tells people and agents where tickets live and where plans go. This repository uses the GitHub issues of `eysenfalk/PiChamber` and plans in pull requests.

| `tracker.type` | Settings | Reference in the pull request |
|---|---|---|
| `github` | `repo` (`owner/name`), `roadmap` (number of the roadmap issue) | `Closes #12` or `Relates to #12`; the branch starts with the number (`12-short-name`) |
| `gitlab` | `url`, `project` | `Closes #12` |
| `jira` | `url`, `project` (the key) | `Closes KEY-12`; the branch starts with the key |
| `local` | `dir` | `Closes issues/012-short-name.md`; the file is deleted in the same change |

`plans` is `pull-request` (the plan is the pull request description) or `file` (the plan is `PLAN.md` in the root, only without a pull request platform). `scripts/workflow/repo-rules.test.mjs` checks both.

## From idea to `main`

| # | Step | Who | How |
|---|---|---|---|
| 1 | Write the idea down | anyone | one line under Ideas in the roadmap issue |
| 2 | Make it a roadmap item | people and agents | an issue labeled `roadmap`, placed in the roadmap issue; before work starts it has problem, requirements, acceptance |
| 3 | Branch and draft pull request | agent | branch named after the issue; draft pull request from the template; the description is the plan |
| 4 | Approve the plan | a person | in the pull request or in chat; nothing is implemented before |
| 5 | Implement and prove | agent | tests and code; checks green; proof recorded; decision records; `CONTEXT.md` updated |
| 6 | Pipeline | CI | build, type check, lint, all tests, the pull request check |
| 7 | Review | a person, supported by a review agent | the description, the proof, the diff, the CI result |
| 8 | Merge | a person | squash merge; it closes the issue, which leaves the roadmap |
| 9 | Gardening | everyone | repeated corrections become tests or lint rules; outdated issues are closed |

### 1. Idea

Ideas cost nothing to write down and nothing to throw away. They are one line each under **Ideas** in the roadmap issue, not issues, so the issue list holds only work that is planned. An idea becomes an issue when it is about to be worked on.

### 2. Roadmap item

Planned work is an issue labeled `roadmap` and a sub-issue of the roadmap issue ([ADR 0003](adr/0003-roadmap-in-issues.md)). Its place among the sub-issues is its place in the order of work; the first three open ones are **Next**. A roadmap item may start as a title; before work on it starts, it says what is wrong or missing and how we will know it is done. It does not say how to build it.

People reorder items by dragging them in the sub-issue list of the roadmap issue. People and agents can also use the command, which regenerates the order list and graph afterwards:

```bash
node scripts/workflow/roadmap-sync.mjs add 12                  # label #12 roadmap and append it
node scripts/workflow/roadmap-sync.mjs add 13 --parent 12      # make #13 a sub-issue of item #12
node scripts/workflow/roadmap-sync.mjs move 12 --before 7      # or --after 7, or --top
node scripts/workflow/roadmap-sync.mjs sync                    # regenerate the order list and graph
```

Dependencies are "blocked by" relations set on the issue in GitHub; the graph draws them. The order list and graph between the markers in the roadmap issue are generated and overwritten; ideas and other text outside them are kept. Bugs that need doing now can be issues without the label.

### 3. Branch and draft pull request

```bash
git fetch origin
git switch -c 12-short-name origin/main
git commit --allow-empty -m "Plan: <what changes> (#12)"   # GitHub needs a commit to open a pull request
git push -u origin 12-short-name
gh pr create --draft --base main --title "<what changes>" --body-file <plan.md>
```

Write the plan from [the template](../.github/PULL_REQUEST_TEMPLATE.md): Issue, Goal, Acceptance criteria, Approach, Affected surfaces, Repository guidance, Verification, Decisions, Findings, Out of scope, Risks and open questions. It should describe one pull request that solves one problem, with roughly 100 to 600 lines to review (lock files and generated assets do not count). Larger work is split into several pull requests and roadmap items.

### 4. Approval

The user approves the plan before code is written. Changing the plan later means updating the description (`gh pr edit <n> --body-file <plan.md>`) and saying so.

**Acceptance criteria are a living checklist.** Each criterion is an observable result plus the proof that shows it. Whoever implements checks a box off (`- [x]`) in the description as soon as that criterion is done and proven, not at the end, and adds new boxes when the plan grows. The `pull-request` check allows open boxes only while the pull request is a draft.

### 5. Implementation

- Follow [AGENTS.md](../AGENTS.md): load the matching project skills and read the nearest `README.md` and `DOCUMENTATION.md` before editing.
- **Proof** for a user-visible change is what the user would see: a recording of the feature in the real program, or at least screenshots, in the pull request, with before and after when behavior changes. Cover the states [CONTRIBUTING.md](../CONTRIBUTING.md#pull-requests) names (desktop and mobile, narrow and wide, light and dark). Unit tests support the proof; they are not the proof. Record through `lab/run record <tour>` into gitignored `.proof/<tour>/`. Publish on the host with `bun run proof:publish -- <pr> <tour>` to the orphan `proofs` branch under `pr-<n>/<tour>/` ([ADR 0004](adr/0004-proof-lab.md)).
- **Reproduce through the lab.** On the host run `bun install --frozen-lockfile` and `bun run build`, then `lab/run up` and `lab/run record lab`. Inspect every PNG, the contact sheet and the whole recording before publishing. `lab/run status` checks the lab at `http://127.0.0.1:3111`; `lab/run down` removes its pod, network and state volume. Tests needing a separate environment run through `lab/run`; everything else stays on the host. The detailed proof steps live in `.agents/skills/pichamber-verify/SKILL.md`.
- **Every proof says how to get there.** For each proof, the description tells a developer how to reach it and check it themselves: the commands from a fresh checkout, the URL to open, and what to look at. A proof the reviewer cannot reproduce is only a claim.
- **Look at the proof before attaching it.** Whoever attaches a screenshot or recording, person or agent, has looked at every screenshot and at the whole recording, and each one shows what its caption claims, readable and not covered. A recording that merely finished is not checked. The description says that this was done.
- The checks that cover the change are green before every commit; `bun run test` (which includes `bun run test:repo`) before the hand-over.
- **Decisions.** A pull request that makes or changes an architecture or process decision adds a record to [docs/adr](adr/README.md), or supersedes one, and updates the owning `README.md` or `DOCUMENTATION.md` when the system's shape changes. The description names the records under `## Decisions`.
- **Findings** go into [CONTEXT.md](../CONTEXT.md) in the same pull request, as an entry with `Source`, `Date` and `Settled by`. A finding is anything learned from outside the code: a GitHub issue, another repository, upstream, a real system, a measurement. Outdated entries are corrected, not appended.
- **Settled context leaves.** `CONTEXT.md` is ephemeral. When a pull request settles an entry, because a record decides it, a document now states it, or the code does exactly what it says, the entry is removed in that pull request. Evidence a decision rests on moves into the record's context first. The description lists added and removed entries under `## Findings`.

### 6. Pipeline

| When | Workflow and job | What |
|---|---|---|
| every pull request | `Pull request checks`: `runtime-compatibility`, `checks` | runtime smoke on supported Node and Bun versions; build, type check, lint, `bun run test` (repository rules, tools, web, UI and Electron) |
| issue changes, every six hours, on demand | `Roadmap`: `roadmap` | `scripts/workflow/roadmap-sync.mjs sync`: regenerates the order list and graph in the roadmap issue |
| every change of a pull request, its title or its description | `Pull request description`: `pull-request` | `scripts/workflow/check-pr.mjs`: every template section present and filled, an issue referenced, acceptance criteria as a checklist, all checked once not a draft |

`bun run test` uses the host runner `scripts/lab/test-env.mjs`: it strips inherited `PICHAMBER_*` runtime selectors except `PICHAMBER_TEST_*`, plus `PICHAMBER`, `PI_PACKAGE_DIR` and `ELECTRON_RUN_AS_NODE`, and retains the invoking Bun for nested suites.

The repository rules in `scripts/workflow/` check decision records and their index, `CONTEXT.md` entries and `workflow.json`. Run them with `bun run test:repo`.

### 7. Review

**Before the hand-over**, the author, person or agent, reads the whole description from top to bottom and checks every statement against what exists now: the code and the diff, the CI result of the last commit, the attached proof, and the real systems it names. Each acceptance criterion is implemented as the approved plan defined it; a deviation is named with its reason. What is no longer true is corrected, what is outdated is removed: the description states the current result, the commits hold the history. Only then does the pull request leave draft.

The reviewer reads the description first, then watches the proof, then reads the diff. Findings that would recur go into a test or lint rule rather than a comment.

### 8. Merge

The repository allows only squash merges, and the squash commit is the pull request title and description, so `git log` on `main` holds every plan. A ruleset keeps the history on `main` linear and blocks the merge until `checks` and `pull-request` are green on a branch that is up to date with `main`.

### 9. Gardening

Agents copy what they find. Whatever is in the code becomes the pattern. So:

- when an agent or a person needs the same correction twice, write a test, a type or a lint rule that makes the mistake impossible;
- no workaround comments: fix the cause or open an issue;
- close issues that the roadmap no longer covers;
- prune `CONTEXT.md`: remove entries that are settled, correct outdated ones, and turn entries that keep waiting into roadmap items or ideas;
- check `Proposed` records: confirm them or supersede them.

## Manual and automatic

| Manual | Automatic |
|---|---|
| ideas | all checks on every pull request |
| roadmap items, their order and their dependencies | the pull request description check |
| approving plans | format of decision records and their index |
| review and merge | fields of every `CONTEXT.md` entry |
| decision records, `CONTEXT.md` entries and their removal | the `workflow.json` configuration |
| | the order list and graph in the roadmap issue |

## Repository settings

Set on `eysenfalk/PiChamber` on 2026-10-02: only squash merges, squash commit title and message from the pull request, and the ruleset `main: linear history`. The ruleset keeps `main` linear and requires the `checks` and `pull-request` jobs on a branch that is up to date with `main`, the GitHub equivalent of a fast-forward merge.
