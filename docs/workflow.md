# Workflow

How work moves from an idea to `dev` and from there to `main` in this repository, who does what, and what is automated. It applies to people and agents alike. [AGENTS.md](../AGENTS.md) carries the short version, and [ADR 0002](adr/0002-workflow-from-jira-connector.md) says where this workflow comes from.

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
| [Roadmap issue #24](https://github.com/eysenfalk/PiChamber/issues/24) | The order of upcoming work as its ordered sub-issues, and a generated order list and graph | sub-issues: people and agents; list and graph: `scripts/workflow/roadmap-sync.mjs` |
| GitHub issues | Ideas, roadmap items (label `roadmap`) and bugs | people and agents |
| Pull request | The plan (how) as slices, its proof, the review and the CI result | agent drafts it at the first plan; the user approves it in the slow lane ([ADR 0013](adr/0013-one-pull-request-with-slices.md)) |
| Git history on `dev` | One squash commit per pull request, containing its title and full description | automatic |
| `main` | Only stable states: a commit of `dev` the owner promoted by fast-forward ([ADR 0008](adr/0008-dev-integration-branch.md)) | the owner |

There is no archive of plans and no hand-maintained catalogue, and no spec folder: the plan of a finished change is its squash commit. A fact is written in one place; anywhere else links to it. A feature map of what users can do, generated from acceptance tests through the lab, is a separate roadmap item after #11.

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

Work is merged into `dev`, the default branch. `main` only moves when the owner promotes a stable state of `dev` (step 10).

| # | Step | Who | How |
|---|---|---|---|
| 1 | Write the idea down | anyone | an issue in the tracker, without the label `roadmap` |
| 2 | Make it a roadmap item | people and agents | an issue labeled `roadmap`, placed in the roadmap issue; before work starts it has problem, requirements, acceptance |
| 3 | Explore, plan, draft pull request | agent | explore first, then a branch named after the issue and a draft pull request from the template at the first plan; the description is the plan, with slices and a lane |
| 4 | Go | a person | slow lane only: in the pull request or in chat; no production code before. The fast lane builds right away |
| 5 | Implement and prove | agent | one commit per slice; tests and code; checks green; proof recorded; decision records; `CONTEXT.md` updated |
| 6 | Pipeline | CI | build, type check, lint, all tests, the pull request check |
| 7 | Review | a person, supported by a review agent | the description, the proof, the diff, the CI result |
| 8 | Merge | a person | squash merge; it closes the issue, which leaves the roadmap |
| 9 | Gardening | everyone | repeated corrections become tests or lint rules; outdated issues are closed |
| 10 | Promote | the owner | fast-forward `main` to a stable commit of `dev`; releases are tagged there |

### 1. Idea

Ideas cost nothing to write down and nothing to throw away ([ADR 0007](adr/0007-ideas-as-issues.md)). An idea is an issue in the tracker of `workflow.json`, or a Markdown file in `tracker.dir` for a local tracker. It says what could be done and where it came from: an issue, a note, a voice note, a conversation or a session. An open issue without the label `roadmap` is an idea, unless it is a bug that needs doing now. There may be hundreds; the roadmap, not the issue list, says what is planned. An idea is closed when it is done, duplicated or no longer wanted.

### 2. Roadmap item

Planned work is an issue labeled `roadmap` and a sub-issue of the roadmap issue ([ADR 0003](adr/0003-roadmap-in-issues.md)); an idea becomes a roadmap item by getting both. Its place among the sub-issues is its place in the order of work; the first three open ones are **Next**. A roadmap item may start as a title; before work on it starts, it says what is wrong or missing and how we will know it is done. It does not say how to build it.

People reorder items by dragging them in the sub-issue list of the roadmap issue. People and agents can also use the command, which regenerates the order list and graph afterwards:

```bash
node scripts/workflow/roadmap-sync.mjs add 12                  # label #12 roadmap and append it
node scripts/workflow/roadmap-sync.mjs add 13 --parent 12      # make #13 a sub-issue of item #12
node scripts/workflow/roadmap-sync.mjs move 12 --before 7      # or --after 7, or --top
node scripts/workflow/roadmap-sync.mjs sync                    # regenerate the order list and graph
```

Dependencies are "blocked by" relations set on the issue in GitHub; the graph draws them. The order list and graph between the markers in the roadmap issue are generated and overwritten; text outside them is kept. Bugs that need doing now can be issues without the label.

### 3. Explore, plan, draft pull request

Explore first: read the issue, the code and the nearest docs, and put what an agent needs to resume into an issue comment. Until there is a plan there is no pull request. The draft pull request opens at the first plan ([ADR 0013](adr/0013-one-pull-request-with-slices.md)):

```bash
git fetch origin
git switch -c 12-short-name origin/dev
git commit --allow-empty -m "Plan: <what changes> (#12)"   # GitHub needs a commit to open a pull request
git push -u origin 12-short-name
gh pr create --draft --base dev --title "<what changes>" --body-file <plan.md>
```

Write the plan from [the template](../.github/PULL_REQUEST_TEMPLATE.md): Issue, Goal, Acceptance criteria, Approach, Affected surfaces, Repository guidance, Verification, Decisions, Findings, Out of scope, Risks and open questions.

**One pull request per undertaking, with slices.** A slice is one contract that can be run or seen and accepted by one check. It is one item of the checklist under Acceptance criteria (the contract and its seam, what can be run or seen, the check that accepts it) and one ordered step under Approach (the files it touches, one commit). A slice has one seam and one review surface, and is reviewable on its own at roughly 100 to 600 lines (lock files and generated assets do not count). If a slice starts changing unrelated things, edit the description first: split it, then continue. Several pull requests only when a part must be live before the rest; the later one is planned after the earlier one merged, and there is no spec folder ([ADR 0013](adr/0013-one-pull-request-with-slices.md), which supersedes [ADR 0009](adr/0009-spec-folder-for-multi-pr-features.md)).

**Name the lane** in the first lines of Approach, with the reason (`Lane: fast, because …`).

### 4. Lane and go

- **Fast, build right away:** a bug fix with a red test first, or a one-slice change with clear acceptance criteria, no new dependency, and no change to an external contract (API, persisted data, config format, visible UI behavior). A change that only touches documentation is never fast.
- **Slow, wait for the user's go after the draft:** every documentation only change, and anything with several slices, an external contract, a migration or deletion, a new dependency, a one-way door, a product question, or questions left open by exploration. While waiting, do what fits any plan: probes, prototypes, red tests for the wanted behavior, reading. No production code before the go.
- **Moving between lanes.** The brief or the plan names the lane. A worker may move to slow, never to fast. A fast plan that grows a second slice or touches a contract stops and moves to slow, and says so in the description.

Changing the plan later means updating the description (`gh pr edit <n> --body-file <plan.md>`) and saying so.

**Acceptance criteria are a living checklist.** Each criterion is an observable result plus the proof that shows it. Whoever implements checks a box off (`- [x]`) in the description as soon as that criterion is done and proven, not at the end, and adds new boxes when the plan grows. The `pull-request` check allows open boxes only while the pull request is a draft.

**What happens after the merge is not a criterion.** Every criterion must be provable before the merge, because the pull request leaves draft only with every box checked. Work that can only follow the merge, such as publishing a release from the merge commit, is a step in Approach and gets its own issue: the squash merge closes the issue the pull request names, so that issue cannot track it.

### 5. Implementation

- Follow [AGENTS.md](../AGENTS.md): load the matching project skills and read the nearest `README.md` and `DOCUMENTATION.md` before editing.
- **One slice, one commit.** Build the next open slice, verify it, commit, push and check its box. The next slice starts when the previous one is verified.
- **Proof** for a user-visible change is what the user would see: a recording of the feature in the real program, or at least screenshots, in the pull request, with before and after when behavior changes. Cover the states [CONTRIBUTING.md](../CONTRIBUTING.md#pull-requests) names (desktop and mobile, narrow and wide, light and dark). Unit tests support the proof; they are not the proof. Record through `lab/run record <tour>` into gitignored `.proof/<tour>/`. Publish on the host with `bun run proof:publish -- <pr> <tour>`: it uploads the video and screenshots into the pull request description through `gh pr edit --attach`, inside the Verification section ([ADR 0005](adr/0005-proof-attached-to-pull-requests.md)). Proof is attached, never committed or linked from a branch. On a GitLab tracker, upload with glab and place the returned Markdown in Verification; GitLab renders a video reference as a player. `glab mr update --attach` only appends at the end of the description, so the `glab` skill describes the upload and placement.
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

**Before the hand-over**, the author, person or agent, reads the whole description from top to bottom and checks every statement against what exists now: the code and the diff, the CI result of the last commit, the attached proof, and the real systems it names. Each acceptance criterion is implemented as the plan defined it (as approved, in the slow lane); a deviation is named with its reason. What is no longer true is corrected, what is outdated is removed: the description states the current result, the commits hold the history. Only then does the pull request leave draft.

The reviewer reads the description first, then watches the proof, then reads the diff. Findings that would recur go into a test or lint rule rather than a comment.

### 8. Merge

The repository allows only squash merges, and the squash commit is the pull request title and description, so `git log` on `dev` holds every plan. A ruleset keeps the history on `dev` linear and blocks the merge until `checks` and `pull-request` are green on a branch that is up to date with `dev`. Because every pull request is tested against the newest `dev`, parallel agents cannot merge each other into a broken state.

### 10. Promote

When the owner calls a state of `dev` stable, `main` is fast-forwarded to it:

```bash
git fetch origin
git push origin <commit>:main    # fast-forward only; force pushes to main are blocked
```

`main` is therefore always an ancestor of `dev`, and a promoted state is the same commit on both. Releases are tagged on `main` ([CONTRIBUTING.md](../CONTRIBUTING.md#release-process)). Promoting is pushing to `main` and needs the owner.

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
| the go for slow lane plans | format of decision records and their index |
| review and merge | fields of every `CONTEXT.md` entry |
| decision records, `CONTEXT.md` entries and their removal | the `workflow.json` configuration |
| | the order list and graph in the roadmap issue |

## Repository settings

Set on `eysenfalk/PiChamber` on 2026-10-02: only squash merges, squash commit title and message from the pull request. Since 2026-10-12 ([ADR 0008](adr/0008-dev-integration-branch.md)) `dev` is the default branch. The ruleset `default branch: linear history and checks` keeps `dev` linear and requires the `checks` and `pull-request` jobs on a branch that is up to date with `dev`, the GitHub equivalent of a fast-forward merge. The ruleset `main: stable, fast-forward only` keeps `main` linear and blocks force pushes and deletion.
