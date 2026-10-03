# 0005. Proof recorded in the lab and attached to the pull request

- Status: Accepted
- Date: 2026-10-03

## Context

[0004](0004-proof-lab.md) decided to store published proof on an orphan `proofs` branch. That rested on an entry in `CONTEXT.md` from 2026-10-02: `gh pr create --help` and `gh pr edit --help` (gh 2.x) offered no way to attach files, only the GitHub web editor could upload. The recorder in [#27](https://github.com/eysenfalk/PiChamber/pull/27) implemented the branch. Its first real proof showed the cost: images rendered from `raw.githubusercontent.com`, but the video was only a download link, not a player.

On 2026-10-03 the owner pointed to GitHub's attachment support. `gh pr edit --help` of the installed gh 2.102.0 documents `--attach`: it uploads images and videos, rewrites a body reference such as `![](./video.mp4)` to the uploaded asset, renders video as a player and accepts up to 50 files. If some uploads fail, the description keeps the successful ones and gh exits nonzero. `glab` 1.120.0 has the same experimental `--attach` on `mr create`, `mr update`, `issue create` and `issue note`, checked against the GitLab CLI documentation the same day.

The owner decided to rework #27 before merging it, so the `proofs` branch never became the workflow on `main`.

## Decision

- The recorder runs in the lab container (`lab/run record <tour>`) and writes only to gitignored `.proof/<tour>/` on the host.
- `bun run proof:publish -- <pr> <tour>` publishes from the host. It accepts only a complete proven recording of the current HEAD, writes a marked block into the Verification section of the pull request description and uploads the video, the contact sheet and every screenshot into it with `gh pr edit --attach`. A later run replaces only its own tour's block. `--dry-run` reads the description and shows the block without changing anything.
- Proof files are never committed and are not kept on a branch. The `proofs` branch and its `pr-<n>/<tour>/` layout are dropped.
- This replaces the storage bullet of 0004; the rest of 0004 remains in force. The consequence in [0002](0002-workflow-from-jira-connector.md) that proof stays outside the repository holds again: proof lives in the pull request.

## Consequences

The video plays inline in the pull request, and the description that becomes the squash commit carries the proof URLs. Uploaded assets live in GitHub's attachment storage; they cannot be listed, versioned or deleted through git, and a replaced block leaves the earlier uploads orphaned there. Publishing depends on a gh release with `--attach` and fails with a clear message without it. A partial upload leaves the description with the successful files and a nonzero exit; rerunning replaces the whole block.

Chrome for Testing runs with `--no-sandbox` only through the lab recorder launcher. The rootless container drops capabilities and forbids privilege escalation, so Chrome cannot use its setuid sandbox, and its namespace sandbox is unavailable in this environment. The container, read-only mounts and internal network are the accidental-access boundary, not Chrome. Host recording keeps Chrome sandbox defaults. The server (1.9 CPUs, 3968 MiB), infra (0.1 CPU, 128 MiB) and recorder (2 CPUs, 4096 MiB) share the fixed 4 CPU / 8 GiB ceiling of 0004; their swap ceilings equal memory.

Rollback is reverting this pull request; already attached proof stays in the descriptions.

## Revisit when

gh removes or changes `--attach`, GitHub limits attachment size or retention below what a proof video needs, or proof must be reviewable outside GitHub.
