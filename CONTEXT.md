# Context

Live context: what we know but have not settled yet. Every entry names its source, its date and what will settle it. The pull request that settles an entry, by a decision record, a document or code, removes it here ([ADR 0001](docs/adr/0001-decisions-and-live-context-in-separate-places.md)). Removed entries remain in the Git history.

## Proof

### Where proof files live

- Source: `gh pr create --help` and `gh pr edit --help` (gh 2.x): no option to attach files to a pull request; checked 2026-10-02
- Date: 2026-10-02
- Settled by: the pull request for the roadmap item "Proof recording and feature map" and its decision record

The GitHub web editor uploads images and videos into a description, the CLI cannot. Proposal: an orphan branch `proofs` with `pr-<n>/<name>/`, linked from the description. Not tried yet: whether images and videos from that branch render inline in a pull request of a public repository.

## GitHub

### Actions on the fork

- Source: `gh run list -R eysenfalk/PiChamber` (no runs), `gh api repos/eysenfalk/PiChamber/actions/permissions` (enabled, all actions allowed)
- Date: 2026-10-02
- Settled by: the first workflow runs on pull request #10; then the ruleset requires the `pull-request` and `checks` jobs and an up-to-date branch

## Upstream

### The fork's workflow files differ from upstream

- Source: pull request #10 changes `AGENTS.md`, `CONTRIBUTING.md` and `.github/PULL_REQUEST_TEMPLATE.md`, which `RyderAsKing/PiChamber` also maintains
- Date: 2026-10-02
- Settled by: a decision record on how the fork follows upstream (merge, rebase or cherry-pick) and which files it keeps as its own

### Plan documents in docs/plans

- Source: `docs/plans/github-pull-requests-and-issues.md` ("Status: accepted", added in 6c1fe72a on 2026-09-27)
- Date: 2026-10-02
- Settled by: a pull request that moves its lasting decisions into a decision record or the owning `DOCUMENTATION.md` and deletes the file

The workflow keeps no archive of plans; plans live in pull requests and their squash commits.
