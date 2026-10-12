# Slice 7. Quick create

Issue #99, closes it and #95. Depends on slice 6 merged into `dev`.

Skills: `pichamber-change-discipline`, `theme-system`, `locale-ui-patterns`, `pichamber-verify`; `ui-api-decoupling` if a server route is needed.

## Contract

One click on a workspace row starts a session there and puts the cursor in the composer. A chat without a folder is one click on Chats.

## API seam

- `+` appears in the fixed right slot of worktree rows, flat project rows and Chats, replacing the count on hover. Never on session rows or over icons.
- `createSessionInWorkspace(target)` uses `openNewSessionDraft({ selectedProjectId, directoryOverride })` as every creation does today and focuses the composer; on Chats the directory is `~`.
- On touch the same action is an item of the long press menu.
- First check whether a draft is enough or the owner expects a persisted empty session. If a server route is needed, split this slice into an API and a UI pull request here first.

## Closing the feature

Move the lasting reasons of this spec into `sidebar/DOCUMENTATION.md` and, where a decision needs it, a record; confirm or supersede ADR 0009; delete `specs/95-workspace-tree/`.

## What the owner sees

Recording: `+` on a worktree, on a flat project, on Chats; long press on mobile.

## Gates

Focused tests, `type-check`, `lint`, `dead-code`, `bun run test`; recording looked at completely; `screenshot-critique` as the last check.
