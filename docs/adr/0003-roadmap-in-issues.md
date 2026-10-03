# 0003. Roadmap in issues: one roadmap issue with ordered sub-issues and a generated graph

- Status: Accepted
- Date: 2026-10-03

## Context

ADR 0002 kept the order of work in `ROADMAP.md` (Next, Later, Ideas) and wrote GitHub issues only for the next one to three items. By 2026-10-03 this had drifted:

- Every item with an issue existed twice, once as a line in `ROADMAP.md` and once as an issue, and the two disagreed: issues #13 to #23 were not in `ROADMAP.md`, and the file said issues are written only for the next items.
- Ideas were filed as quick issues with a title and no text (#14, #17, #18, #22, #23), which filled the issue list. The user wants as few issues as possible.
- Neither place showed how items depend on each other, and changing the order meant a pull request.
- A chief of staff session that plans and orders work for the user (#20) needs to change the order through an API, not by editing a file on a branch.

GitHub has sub-issues with an ordered list that the web interface reorders by drag and drop and the REST API by `PATCH /repos/{owner}/{repo}/issues/{n}/sub_issues/priority`, and "blocked by" dependencies (`/issues/{n}/dependencies/blocked_by`). Both answered on this repository on 2026-10-03. GitHub renders Mermaid diagrams in issue bodies.

On 2026-10-03 the user decided: roadmap items are issues with their own label, `ROADMAP.md` goes away, one roadmap issue tracks all items and shows their graph, and the assistant can reorder as well as people.

## Decision

- A roadmap item is an issue labeled `roadmap` and a sub-issue of the roadmap issue, #24, named by `tracker.roadmap` in `workflow.json`. Large items may have sub-issues of their own.
- The order of the roadmap issue's sub-issues is the order of work; the first three open ones are Next.
- The roadmap issue has a generated section, an order list and a Mermaid graph (tree from sub-issues, "blocked by" edges, Next highlighted), between `<!-- roadmap:start -->` and `<!-- roadmap:end -->`. `scripts/workflow/roadmap-sync.mjs sync` writes it; the workflow `roadmap.yml` runs it on issue events, every six hours and on demand.
- Ideas are one line each in the roadmap issue, outside the generated section. An idea becomes an issue only when it is about to be worked on.
- People and agents add and reorder items in the GitHub interface or with `roadmap-sync.mjs add` and `move`. Agents may create issues; closing issues still needs approval.

## Consequences

- The order of work no longer lives in the repository, so it has no history in Git and is not reviewed in pull requests. The issue's edit history and the sub-issue events keep a trail.
- Finishing an item needs no edit: the squash merge closes the issue, and the closed issue leaves the generated list.
- The roadmap depends on GitHub sub-issues. GitLab, Jira and local trackers have no roadmap issue yet; `repo-rules.mjs` requires `tracker.roadmap` only for GitHub.
- Anything written by hand inside the generated section is overwritten.
- Only open issues are loaded, up to 99 per list and three levels deep; the script fails instead of dropping items beyond that.

## Revisit when

The roadmap holds more than about 50 open items, the fork moves away from GitHub, or the order needs fields that sub-issues cannot carry (dates, estimates, owners), at which point a GitHub project may fit better.
