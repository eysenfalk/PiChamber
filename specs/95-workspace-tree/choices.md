# Choices made while building #95

Decisions the implementing agent took without asking, per slice. The owner can overturn any of them; the last pull request folds what lasts into `sidebar/DOCUMENTATION.md` and deletes this file with the spec.

## Slice 2. Tree in the sidebar

| Choice | Why | Cost if wrong |
|---|---|---|
| The component is `sidebar/SidebarWorkspaceTree.tsx`, not `WorkspaceTree.tsx` as the slice named it. | `WorkspaceTree.tsx` next to `workspaceTree.ts` collides on case-insensitive resolution; bun failed with `ENOENT` in the full suite. | A rename. |
| Session rows reuse `SessionNodeItem` with a new render context `'tree'` and its own menu and expansion keys (`tree:active:<id>`). | Rename, archive, pins, export, unread and bulk select keep working without a second row component. | `SessionNodeItem` carries one more branch until slice 3 removes the `project` context. |
| Tree rows use `min-h-6`, not `h-6`; guide lines stretch with the row. | Hosted mobile raises every button to a 36 px touch floor (`mobile.css`), which pushed titles 4 px above the chevrons in fixed 24 px rows. Desktop stays at 24 px. | Mobile rows are 36 px tall; denser mobile rows need an exception in `mobile.css`. |
| Project labels go through `formatProjectLabel`, like the old sidebar (`lab-alpha` shows as "Lab Alpha"). | Parity: the owner sees the same names before and after. | One call to remove if raw names are wanted. |
| The lab seed titles are short ("Lab: tools session", "Lab: fork child", "Lab: docs check") and the seed runs under a scoped clock. | Long titles truncate in a 280 px sidebar and the recorder waits for full text; Pi's SessionManager owns timestamps and has no clock parameter. | Lab-only. |
| Measured the model instead of a streaming profile: 16 worktrees, 200 sessions, `buildWorkspaceTree` 0.21 ms per activity event; 122 rows with everything expanded, 22 by default, 4 collapsed. | The lab is offline, and `profile:session` needs a real model. Rebuild cost is far below a frame, so re-sorting churn did not justify the extra slice the README held open. | React render counts while streaming are still unmeasured; slice 3 measures them on a real server if the owner sees lag. |
| `SidebarSpacesBar.tsx` stays as an unused file, and `useSidebarPersistence` still reads the old `projectCollapse` key. | The slice keeps the old components as files and lets slice 3 delete them together with their tests. `dead-code` reports the file. | None after slice 3. |
| "Other folders" and the untitled "Awaiting first prompt" row are filed as #103 and #104, not fixed here. | Both come from the session catalog, not the tree; the old sidebar shows the same catalog. | Until fixed, the "Other folders" group never appears, and every load shows one unprompted row. |
