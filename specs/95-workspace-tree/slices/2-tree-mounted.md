# Slice 2. Tree in the sidebar

Issue #96. Depends on slice 1 merged into `dev`.

Skills: `pichamber-change-discipline`, `sync-state-invariants`, `performance-engineering`, `theme-system`, `locale-ui-patterns`, `pichamber-verify`.

## Contract

One tree replaces both areas of the sidebar. Clicking a project or worktree selects and expands it and opens no session. New session uses the selected node. The folder cycle shortcuts move the selection.

## API seam

- New `sidebar/WorkspaceTree.tsx` with project, worktree, Chats and Other rows, mounted in `SessionSidebar.tsx` where `SidebarSpacesBar` (:1355) and `SidebarProjectsList` (:1388) are today. One hook reads the stores and feeds `buildWorkspaceTree`; rows only render.
- Session rows reuse `SessionNodeItem` at 24 px with guide lines, so archive in the time slot, pins, export, unread, rename and bulk select keep working.
- `useSidebarSpaceStore` becomes `{ selectedNodeKey, select(key) }` and filters nothing. `lib/folderCycle.ts` moves the selection and opens no session; `folderCycleSelection.test.ts` is updated.
- Expansion: `oc.sidebar.tree.expanded.v1`, one writer, local only. When nothing is stored, `defaultExpanded` applies; when the active session changes, its ancestors are expanded once.
- The old collapse writers stop: `useSidebarPersistence` for `sidebarCollapsed` and `settingsMirror.ts:140`. `scripts/perf/scenario.mjs` is moved to the new key.
- Rollups on collapsed nodes come from the model; `ProjectAggregateStatusIndicator` is no longer used.
- Context menu, the 500 ms long press as one shared hook, and Close worktree move over from `SidebarSpacesBar`.

## Lab seed and tour

- `lab/seed-manifest.json` and `scripts/lab/seed.mjs` get an initial commit, two worktrees in lab-alpha, a fork chain, a chat session in the lab home and a session in a foreign folder; `seed.test.mjs` covers it.
- New tour `sidebar-tree` in `scripts/proof/tours.mjs` and the `lab/run` guard, recorded desktop wide and narrow, hosted mobile, light and dark.

## Measurement

Before and after, with about 14 worktrees and 200 sessions: render counts from the existing counters `ui.session_sidebar.source.*` (`SessionSidebar.tsx:817-827`) while a session streams, and the row count with everything expanded. Results go into the pull request; if re-sorting churns, add a slice before 3 as the README's unknowns say.

## What the owner sees

`bun run dev` with his real projects, and the recording.

## Gates

Focused tests, `type-check`, `lint`, `dead-code`, `bun run test`; lab recording. Look at every screenshot and the whole recording, then run `screenshot-critique` on the shots as the last check before the slice is accepted, and `compare-screenshots` against the preview `/tmp/pichamber-sidebar-preview` renders and the before shots.

## Left to the implementer

Component split, memo and subscription boundaries, guide line styling within the theme tokens, focus handling details.

## Accepted gaps until slice 3

Project drag to reorder, the session folder level, keyboard navigation. The old components stay in the tree of files but are unmounted; slice 3 deletes them.

## Stays green

Existing sidebar tests except those of unmounted components, which slice 3 deletes together with them.
