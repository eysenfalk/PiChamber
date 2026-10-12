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

## Slice 3. Parity and cleanup

| Choice | Why | Cost if wrong |
|---|---|---|
| Drops stay inside one folder scope: a session or folder moves only between folders of the same worktree or flat project, and a project drops only on another project. | Moving a session to another scope would mean changing its working directory, which the old sidebar never did by drag either. | Cross-worktree moves need a real "move session" operation first. |
| Touch devices drag from a handle that appears on draggable rows; mouse drags from the row after 8 px. | A press and hold on a row already opens its context menu (500 ms), so a row-wide touch drag would fight it. | One extra 24 px icon on touch rows. |
| One `DndContext` for the whole tree with `pointerWithin` collision, and no sortable animation: a drop line shows where a project lands, a ring shows the target folder. | Rows are a flat list of mixed kinds; dnd-kit's sortable strategy fits one homogenous list, not projects plus folders plus sessions. | Reordering feels less fluid than the old projects bar. |
| Keyboard: roving tab stop, `n` creates a session on Chats, project and worktree rows, keys act only when they start on the treeitem. | The slice named the keys; ignoring keys from inner inputs keeps folder rename and row buttons working. | `n` may clash with a future global shortcut. |
| Search counts matching sessions in the header but does not narrow the tree until slice 4. | Slice 4 owns tree search (query in `buildWorkspaceTree`, its data layer is ready); keeping the old filter would have kept the old grouping pipeline alive. | Between this merge and slice 4, search in `dev` finds nothing visible. |
| Session rows drop the inline branch label, and the sidebar no longer subscribes to all Git branches or the per-project repo status map (`useGitRepoStatusMap` deleted). | The worktree row names the branch; slice 5 brings branch and change state back through its own status scheduler. | Until slice 5, a flat project shows no branch. |
| `VirtualArchivedSessionList`, archived auto-folders and `background-network.ts` are deleted. | Archived sessions already live in the Archive dialog, so nothing rendered them; the network helper had no caller left. | None known. |
| `useSessionDisplayStore` and `formatPathForDisplay` are deleted; the persisted `pichamber:session-display-settings` key stays in browsers unread. | Their flags (sticky zone headers, recent section, inline archive) and the path label belonged to the old zones. | A stale few bytes in local storage; no migration, per the spec's no-migration rule. |
| The proof recorder learned `press`, `drag` and right-click, runs Chromium with a fine hovering pointer, and switches touch emulation only when the viewport kind changes. | The tour has to show drag, folders and keys; headless Chromium otherwise reports a coarse pointer, which hides row drag and shows touch handles on desktop. | Recorder changes are shared by all tours; `bun test scripts/proof` covers the format. |
| The tour waits 300 ms after a drop before clicking the folder. | dnd-kit swallows a click that follows a drop within its activation window; a person never clicks that fast. | A slow lab could need a longer wait. |

| Every tree row draws its guides as one span and reserves the 16 px chevron column, also session rows without forks and rows without a touch drag handle. | The unprimed critique found session rows under-indented next to folders at the same level, and mobile counts jumping where a handle was missing. One column grid keeps siblings aligned at any depth. | Rows lose a few pixels of title width at deep levels; the deep-session tour evidence checks the fork toggle instead of an ellipsized title. |
| Tree items opt into the design system's focus ring with `data-focus-ring="accent"` instead of Tailwind `focus-visible:ring`. | `styles/design-system.css` strips every focus ring with `!important`; `data-focus-ring` is its only opt-in, so keyboard focus was invisible before. | If the design system changes the opt-in, tree focus goes invisible again; frame 06 of the tour shows it. |

## Slice 4. Visibility filter and quick search

| Choice | Why | Cost if wrong |
|---|---|---|
| The visibility checklist is a dropdown menu with checkbox items behind an eye button (eye-off plus a count badge when projects are hidden), with Show all and Hide all at the bottom. | It reuses the dropdown primitives the header already has and keeps the header one row tall; the badge says something is hidden without opening the menu. | A long project list would want a scrolling popover with its own search. |
| Search runs on the existing 120 ms debounce, highlights matches with the existing mark style and shows the match count from the tree model. | Same feel as the old session search, one source for the count. | None found; the dark mark is loud, but it was already the session search style. |
| A query only narrows the tree while the search box is open; Escape clears text first, a second Escape closes the box. | A closed box with leftover text would filter the tree invisibly. | Somebody who wants to keep a filter while the box is closed loses it. |
| The search box no longer closes on a click outside it; the outside click listener and the rAF focus hook are deleted, `autoFocus` focuses the input. | Clicking a result in the narrowed tree would otherwise close the search and throw the view away. | Search stays open until the person closes it. |
| "Add folder" is hidden while a query is active. | Search results are a view, not a place to add projects. | None expected. |
| Hidden projects that match a search show an eye-off mark (an image with the label "Hidden from the sidebar"). | The person has to see why a project appears that they hid. | None expected. |
| No virtualization. A match-everything query renders the full tree, the same rows as no query, which slice 2 measured. | Search only removes rows. | Very large real trees would need virtualization regardless of search. |
| The tour addresses lab projects by their real id `path_<base64url of the path>`. | Projects added by path get that id; `lab/start.mjs` names are only labels. | A changed id scheme breaks the tour, loudly. |

