# Slice 6. Auto fetch

Issue #98, closes it. Depends on slice 5 merged into `dev`.

Skills: `pichamber-change-discipline`, `settings-ui-patterns`, `locale-ui-patterns`, `ui-api-decoupling`, `pichamber-verify`.

## Contract

With the setting on, ahead and behind stay current without the owner fetching, and a fetch can never hang on a credential prompt.

## API seam

- Server: the fetch route runs git with `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_ASKPASS=''`, `SSH_ASKPASS=''` (as `github/routes.js:104`) and a timeout, so it fails instead of asking. A test proves a repository that needs credentials fails fast.
- Setting: Auto fetch, off by default, interval 5, 15, 30 or 60 minutes, default 15.
- The scheduler from slice 5 fetches once per repository (not per worktree), visible projects only, paused while the window is hidden, then refreshes the light status. Errors block nothing and show in the `↑↓` tooltip.

## What the owner sees

The setting, and a recording where a remote commit appears as `↓1` without a manual fetch.

## Gates

Server test, focused UI tests, `type-check`, `lint`, `bun run test`; recording looked at completely; `screenshot-critique` as the last check.

## Left to the implementer

Timer and visibility handling details.
