# Slice 3. Parity and cleanup

Issue #96, closes it. Depends on slice 2 merged into `dev`.

Skills: `pichamber-change-discipline`, `drag-to-reorder`, `locale-ui-patterns`, `pichamber-verify`.

## Contract

Everything the old sidebar could do works in the tree, and the old components are gone.

## Scope

- Project drag to reorder on project rows with separate mouse and touch sensors; on touch, a drag handle if long press and drag conflict.
- Session folder level under a worktree, moving sessions into folders, folder drag.
- Keyboard: Up and Down move focus through visible rows, Left and Right collapse and expand, Enter opens a session or toggles a node, `n` creates a session on a workspace row (slice 7 adds `+`). Roving focus, no new dependency, tree ARIA roles.
- Bulk selection scoped to tree nodes.
- Deleted: `SidebarSpacesBar`, `SidebarProjectsList` and its test, `SessionGroupSection`, `SessionGroupHeader`, `sortableItems`, `useGroupOrdering`, `useSessionSidebarSections`, `buildGroupedSessions`, `allFoldersOnlySection`, the path containment in `useSessionGrouping.ts:91-95`. `VirtualArchivedSessionList` only if the archived bucket is unreachable.
- Docs: rewrite `sidebar/DOCUMENTATION.md` for the tree; change the global sessions note in `sync/DOCUMENTATION.md:124` to the Chats node.

## What the owner sees

The `sidebar-tree` tour extended with drag, folders and keys, including hosted mobile.

## Gates

Focused tests, `type-check`, `lint`, `bun run dead-code` with its report read, `bun run test`; recording looked at completely; `screenshot-critique` as the last check.

## Left to the implementer

Sensor thresholds within the drag-to-reorder skill, file layout of the keyboard hook.

## Feedback that changes this slice

If the owner finds a missing old feature in the recording, it is added here before #96 closes.
