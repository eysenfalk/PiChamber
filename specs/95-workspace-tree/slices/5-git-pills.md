# Slice 5. Git pills and pull requests

Issue #98, first part. Depends on slice 4 merged into `dev`.

Skills: `pichamber-change-discipline`, `sync-state-invariants`, `performance-engineering`, `theme-system`, `locale-ui-patterns`, `ui-api-decoupling`, `pichamber-verify`.

## Contract

Every visible worktree row shows its change state, ahead and behind, conflicts and its pull request, without flooding the server.

## API seam

- New `sidebar/useWorktreeStatusScheduler.ts`, driven by visible rows of visible projects only: at most 2 light status calls at once; refresh on expand, window focus, end of a session turn, otherwise every 60 s. Cache in `useGitStore`.
- Pills per D4: `●N`, dimmed `✓`, `↑N ↓N` only when not 0 with the time of the last fetch in the tooltip, a cloud when there is no upstream, a warning icon from `mergeInProgress`, `rebaseInProgress`, `attentionReason`, `?` on failure. A collapsed project shows `N dirty`.
- Pull request number per worktree in its status color; `useEnsureGitHubPrStatus` is called once per worktree, no longer per session row.
- The model's `merged` group is fed from `useGitHubPrStatusStore`: merged worktrees dimmed under a collapsed "N merged" at the bottom of the project.
- `useProjectRepoStatus` is deleted; the root branch comes from the light status.

## What the owner sees

Recording with a dirty worktree, one ahead and behind, one without upstream, one in a rebase, one merged.

## Gates

Focused tests including the concurrency limit and the failure state, `type-check`, `lint`, `dead-code`, `bun run test`; a count of status requests per minute with 14 worktrees; recording looked at completely; `screenshot-critique` as the last check.

## Left to the implementer

Scheduler internals, pill markup within the theme tokens.
