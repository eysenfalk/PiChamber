# Slice 1. Tree model

Issue #96, pull request #100. Depends on nothing.

## Contract

For fixed input, every active session lands in exactly one node, and nodes are ordered by D8, D11 and D6. Nothing renders yet.

## API seam

New pure module `packages/ui/src/components/session/sidebar/workspaceTree.ts`, no React, no store access:

```ts
type NodeKey =
  | 'chats' | 'other'
  | `p:${projectId}` | `w:${directory}` | `f:${directory}:${folderId}`
  | `s:${sessionId}` | `more:${parentKey}` | `merged:${projectId}` | `o:${directory}`;

type TreeNode = {
  key: NodeKey;
  kind: 'chats' | 'project' | 'worktree' | 'folder' | 'session' | 'more' | 'merged' | 'other' | 'otherFolder';
  label: string;
  children: TreeNode[];
  sessionCount: number;      // sessions below, forks included
  forkCount: number;         // direct forks of a session
  lastActivity: number;
  rollup: { running: boolean; waiting: boolean; unseen: boolean };
  session?: Session; worktree?: WorktreeInfo; projectId?: string; directory?: string;
};

buildWorkspaceTree(input): { roots: TreeNode[]; sessionCount: number };
defaultExpanded(tree, activeSessionId): Set<NodeKey>;
visibleRows(tree, expanded: Set<NodeKey>, revealedMore: Set<NodeKey>): TreeRow[]; // { key, depth, node, expanded, guides: boolean[] }
formatTreeAsText(rows: TreeRow[]): string;
```

`input` holds projects in manual order, worktrees per project, the ownership index, active sessions, the home directory, pins, folders, live status (`running` or `waiting` per session), unseen ids and whether worktree discovery is complete. The `merged` group stays empty until slice 5 feeds it.

Change to an existing module: `buildSessionOwnershipIndex` returns `unownedSessions` instead of dropping them and stays the only place that decides where a session belongs.

Rules the model fixes:

- A project with one worktree is flat: its sessions hang under the project row.
- Chats holds sessions with directory `~`; it is always first, even when empty.
- Other folders holds ownerless sessions grouped by exact directory, is last, absent when empty, and is not computed while discovery is incomplete (those sessions keep their last placement).
- Forks nest under their parent at any depth and count into the parent's `forkCount`.
- Folders appear as a level only when the worktree has session folders.
- Order inside a worktree: running, waiting, pinned, last activity. Cut after 5 with a `more` row; revealing is transient (`revealedMore` is not persisted).
- Archived sessions are not in the tree.
- Default expansion: the project and worktree of the active session; everything else and all forks collapsed.

## What the owner sees

`bun test --isolate packages/ui/src/components/session/sidebar/workspaceTree.test.ts` prints one fixed fixture world as indented text, for example:

```text
Chats (3)
▾ PiChamber
  main  4
  ▸ 39-reload-restart  3  ⑂3
Other folders
  ~/scratch/tmp  1
```

One snapshot per rule above, plus a conservation test: sessions in the tree equal active sessions in the catalog. A failed or partially loaded directory keeps its last rows.

## Also in this pull request

This spec and [ADR 0009](../../../docs/adr/0009-spec-folder-for-multi-pr-features.md) (Proposed).

## Gates

`bun test --isolate` on the new tests and the ownership tests, `bun run type-check`, `bun run lint`, `bun run test:repo`, `bun run dead-code` (new exports), then `bun run test`.

## Left to the implementer

Internal helpers and file split inside `sidebar/`, the exact text format of `formatTreeAsText`, fixture names.

## Stays green

All existing sidebar and sync tests; the running sidebar is unchanged.

## Feedback that changes this slice

The owner wants a different order or grouping after seeing the text snapshots: change the model here, before anything renders.
