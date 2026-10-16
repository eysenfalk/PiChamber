# 0008. Work merges into dev, main only fast-forwards to stable states

- Status: Accepted
- Date: 2026-10-12

## Context

Until now every pull request was squash merged into `main` ([ADR 0002](0002-workflow-from-jira-connector.md)). Many agents work in parallel worktrees, and a feature like the sidebar tree (#95) lands as several pull requests in a row. Between two of them `main` holds a half finished state. On 2026-10-12 the owner decided: there is a `dev` branch that all work is merged into, and only what is stable reaches `main`. The owner asked for this to be set up directly, without a pull request.

Findings from 2026-10-12:

- GitHub interprets closing keywords such as `Closes #12` only in pull requests that target the default branch; on any other base they are ignored and merging has no effect on the issue ([GitHub Docs, Linking a pull request to an issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)). The roadmap depends on issues closing at the merge ([ADR 0003](0003-roadmap-in-issues.md)).
- A merge queue is available only in repositories owned by an organization ([GitHub Docs, Merging a pull request with a merge queue](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue)). `eysenfalk` is a user account.
- The repository allows only squash merges. The ruleset `main: linear history` targets the default branch and requires `checks` and `pull-request` on a branch that is up to date.
- `Pull request checks` run on pull requests to any base; nothing runs on a push. A squash commit therefore has no check runs of its own.
- Releases are built from `v*` tags (`release.yml`). Git Flow suits explicitly versioned software, and its author recommends something simpler for continuous delivery ([nvie.com, note of reflection, 2020](https://nvie.com/posts/a-successful-git-branching-model/)). Guides for parallel coding agents recommend one short lived branch per task in its own worktree, merged through a verify gate so the integration branch never goes red.

Alternatives considered:

- **Trunk based on `main` with feature flags:** keeps one branch, but then `main` is only as stable as its last green build, and the owner wants to decide what is stable.
- **Full Git Flow with release and hotfix branches:** more branches than one owner needs; release branches already exist for release candidates (`CONTRIBUTING.md`).
- **Promotion by pull request `dev` to `main`:** a squash would make `main` and `dev` diverge after every promotion, a merge commit would break the linear history and need merge commits allowed.

## Decision

- **`dev` is the default branch.** Work branches start from `origin/dev`, and every pull request targets `dev` and is squash merged there. Closing keywords keep closing issues.
- **`main` holds only stable states.** It moves only by a fast-forward push to a commit of `dev` that the owner calls stable: `git push origin <commit>:main`. `main` is therefore always an ancestor of `dev`, and a stable state has the same commit on both. Pushing to `main` still needs the owner's approval.
- **Releases are tagged on `main`** after the promotion. Release candidates keep their temporary `release/X.Y.Z` branches; fixes are forward-ported to `dev`.
- **Rulesets:** the existing ruleset follows the default branch and now protects `dev` (linear history, `checks` and `pull-request` green on an up to date branch). A ruleset for `main` keeps it linear and forbids force pushes and deletion. It requires no checks, because the promoted squash commits have no check runs of their own; their checks ran on the pull request against the up to date `dev`.
- This replaces the parts of ADR 0002 that name `main` as the merge target, the branch point and the branch under the ruleset. The rest of ADR 0002 stays in force.

## Consequences

- A feature delivered in several pull requests may be half finished on `dev`, never on `main`.
- Parallel agents cannot merge each other's work into a broken `dev`: a pull request behind `dev` must be updated and rerun its checks first.
- A hotfix lands on `dev` like any change and is promoted. If `dev` holds work that must not ship, that work is reverted on `dev` first, or the fix goes through a `release/X.Y.Z` branch cut from `main`.
- Pages that are deployed from `main` (`docs-source.yml`) update only on promotion.
- Open pull requests were retargeted to `dev`; worktrees created before 2026-10-12 still track `origin/main` and are rebased onto `origin/dev` when touched.

## Revisit when

The repository moves to an organization (merge queue), promotions happen so rarely that `dev` and `main` drift for weeks, or `main` needs states that are not on `dev`.
