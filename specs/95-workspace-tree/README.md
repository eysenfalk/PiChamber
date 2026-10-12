# 95. Sidebar workspace tree

Temporary spec for #95 ([ADR 0009](../../docs/adr/0009-spec-folder-for-multi-pr-features.md)). The last pull request of the feature deletes this folder after moving what must last into `packages/ui/src/components/session/sidebar/DOCUMENTATION.md`.

## Next agent prompt

Status 2026-10-12: spec written, nothing implemented. Slice 1 is planned in draft PR #100 and waits for the owner's approval.

You are picking up the sidebar workspace tree. Read this README, then the slice file of the next open slice, then `AGENTS.md` and every project skill the slice names. Work in one branch and one draft pull request per slice, based on `origin/dev`. Start a slice only after the previous one is merged into `dev`; slices are not stacked. Do not implement before the owner approved the pull request's plan.

Next pickup: [slice 1, tree model](slices/1-tree-model.md) in PR #100.

Blockers: none besides plan approval.

Global TODO:

- [ ] [1 Tree model](slices/1-tree-model.md) (#96, PR #100)
- [ ] [2 Tree in the sidebar](slices/2-tree-mounted.md) (#96)
- [ ] [3 Parity and cleanup](slices/3-parity.md) (closes #96)
- [ ] [4 Visibility filter and quick search](slices/4-filter-search.md) (closes #97)
- [ ] [5 Git pills and pull requests](slices/5-git-pills.md) (#98)
- [ ] [6 Auto fetch](slices/6-auto-fetch.md) (closes #98)
- [ ] [7 Quick create](slices/7-quick-create.md) (closes #99, deletes this folder)

When you finish a slice: check its box, update the status line and the next pickup, and correct anything in this spec the work proved wrong, in the same pull request.

## Goal

The left sidebar is one compact tree, project then worktree then sessions, instead of a spaces area above a session list filtered by it. Running and dirty work is visible without scrolling. The owner can choose which projects are shown, sees branch and change state on every worktree row, and can open a chat session without a folder.

Non goals: the "working on" marker and filter (#2, adapted later), the Intents view (#73), a theme change, a new dependency, virtualization unless a measurement demands it.

## Decisions

The design was settled on 2026-10-12 in an explore-unknowns walk and a spec interview with the owner. Numbers D1 to D17 are those of #95.

| # | Decision |
|---|---|
| D1 | One tree Project, Worktree, Sessions. The separate session area goes away. Collapsed worktree row: `⎇ 39-reload-restart ●1 ↑13 ↓10 3`. |
| D2 | The tree is what #73 calls the workspace view; #73 becomes a Workspaces/Intents toggle on top of it. |
| D3 | A header button opens a checklist of projects with All and None. Hidden projects stay registered; the choice persists across desktop and web. Quick search over project, branch and session title expands the hits; Esc resets it. |
| D4 | Changes = staged + unstaged + untracked. `●N` when dirty, dimmed `✓` when clean, `↑N ↓N` only when not 0, a warning icon for conflict, rebase or merge, `N dirty` on a collapsed project. Refresh only visible rows: on expand, window focus, end of a session turn, otherwise every 60 s; at most 2 light status calls at once; a failure shows `?`. |
| D5 | A **Chats** node on top holds sessions whose directory is the literal `~` ("Don't work in a folder"). The global New session button stays and targets the selected node. |
| D6 | Forks nest collapsed under their parent, which shows `⑂N`; the fork tint from `forkColor.ts` stays. Session folders appear as a level under a worktree only when there are any. Pins sit on top with their icon. |
| D7 | The old #2 attempt in worktree `glowing-island` is not touched. |
| D8 | Projects keep their manual drag order (`useProjectsStore.manualProjectOrder`), Chats fixed on top. In a project the primary checkout first, then worktrees by last activity. Sessions: running, waiting for input, pinned, recency; at most 5, then an "N more" row. |
| D9 | Pull request number per worktree in its status color. Merged worktrees are dimmed in a collapsed "N merged" group at the bottom of the project and never deleted automatically; archiving stays a dialog. |
| Q3 picks | 24 px rows, git state as pills, merged grouped, single-worktree projects flat (sessions directly under the project), fork tint on, guide lines on, time always shown. |
| `+` | Only on workspace rows (worktrees, flat projects, Chats). A fixed right slot shows the session count and turns into `+` on hover. No `⋯` button; the row menu opens on right click or long press; key `n` creates a session. |
| D11 | Sessions whose directory belongs to no registered project go to an **Other folders** node at the bottom, grouped by exact directory, hidden when empty. |
| D12 | Clicking a project or worktree selects and expands it and opens no session. |
| D13 | Conflict state comes from `mergeInProgress`, `rebaseInProgress` and `attentionReason` of `GitStatus`. |
| D14 | The tree model is a pure, tested function before any UI. |
| D15 | No virtualization unless a measurement on real data needs it. |
| D16 | The catalog keeps loading sessions of hidden projects, so search still finds them. |
| D17 | Auto fetch: a setting, off by default, with an interval. One fetch per repository, visible projects only, paused while the window is hidden. Errors block nothing and show in the tooltip of the `↑↓` pill. Git runs non-interactively. |
| Spec Q3 | Hard cutover: the tree uses new storage keys and starts from defaults. Old keys are neither read nor deleted. Pins, session folders and the remembered active session per project keep working unchanged. |
| Spec Q4 | The first checkpoint is the model printed as text; from slice 2 on the real sidebar via `bun run dev`. No fixture page, no old/new toggle. |
| Ladder | Seven pull requests, not stacked, each started after the previous one is merged into `dev` ([ADR 0008](../../docs/adr/0008-dev-integration-branch.md)). Half finished states between them live on `dev`, never on `main`. |

Rejected: a Rust or WASM rewrite of the UI; a sidebar validation harness; twelve smaller pull requests (the owner chose seven); stacking slices 2 to 3.

## Ladder

```text
1 model ─► 2 tree mounted ─► 3 parity ─► 4 filter+search ─► 5 git pills ─► 6 auto fetch ─► 7 quick create
```

The order follows the owner's choice: the tree first, then the filter he called the most important, then git signals, then `+`. Each slice is usable on `dev` when merged. Between slice 2 and 3, drag to reorder, the session folder level and keyboard navigation are missing on `dev`; that is accepted.

## Single-owner rules

Every implementing pass keeps these. A slice that needs to break one updates this list first.

- **Where a session belongs:** `buildSessionOwnershipIndex` (`sidebar/sessionOwnership.ts`) only. It returns ownerless sessions as `unownedSessions` instead of dropping them.
- **Tree shape, order, the five-row cut and rollups:** `sidebar/workspaceTree.ts` only. Renderers never sort or filter.
- **Running and waiting:** the live status index, never persisted history.
- **Selected node:** `useSidebarSpaceStore`, as `selectedNodeKey`. It no longer filters sessions; the All sessions state disappears.
- **Expansion:** the key `oc.sidebar.tree.expanded.v1` with one writer, stored locally, not mirrored to desktop settings.
- **Project order:** `useProjectsStore.manualProjectOrder`. Worktree order follows D8; `oc.sessions.groupOrder` is no longer read.
- **Project visibility:** one store, synced through desktop settings like other UI settings (slice 4).
- **Git status of rows:** one scheduler with `useGitStore` as cache (slice 5). `useProjectRepoStatus` is deleted.
- **Merged state:** `useGitHubPrStatusStore`, requested once per worktree, not once per session row (slice 5).
- **Search:** the tree quick search only; the old session search is deleted in slice 4.
- **Target of a new session:** the selected node; `+` passes its own row as explicit target.

End state: the sidebar reads as if designed as a tree from the start. No adapter keeps the spaces bar or the project zones alive after slice 3.

## Known traps

Found by the code sweep and the four draft plans. Each has an owning slice.

| Trap | Slice |
|---|---|
| `settingsMirror.ts:140` writes `oc.sessions.projectCollapse` back from desktop settings or deletes it. The tree must not depend on it; the writer stops with the old collapse logic. | 2 |
| `scripts/perf/scenario.mjs:16` depends on the old collapse key and would silently stop measuring. | 2 |
| `sessionOwnership.ts:167-173` skips global sessions and drops ownerless ones. | 1 |
| `ProjectAggregateStatusIndicator` scans the whole catalog on every event, once per collapsed project. Replaced by the model's rollup. | 2 |
| Every session row calls `useEnsureGitHubPrStatus`: one request per session instead of per worktree. | 5 |
| Long press is hand-rolled twice in `SidebarSpacesBar.tsx` (500 ms) and conflicts with touch drag (200 ms). One shared hook, drag on touch by handle if they conflict. | 2, 3 |
| "Other folders" may only be computed when worktree discovery is complete (`worktreeTopologyState`), otherwise sessions of a worktree flash there. | 1, 2 |
| `buildKnownSessionDirectories` feeds both the sidebar and `pi-session-catalog-feeder.tsx`; hiding a project must not stop the feeder. | 4 |
| `sync/DOCUMENTATION.md:124` says global sessions show only under All sessions. | 3 |
| Fetch can hang on a credential prompt. Use `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_ASKPASS=''`, `SSH_ASKPASS=''` as in `github/routes.js:104`. | 6 |

## Unknowns

| Unknown | Settled by | If it goes wrong |
|---|---|---|
| Re-sorting on every running or waiting change causes render churn | measurement in slice 2 | sorting stays stable while a row is visible, as its own slice |
| Row count of a full search on real data | slice 4 | a virtualization slice before slice 4 merges |
| Long press versus touch drag on project rows | slice 3, hosted mobile recording | drag handle on touch |
| Bulk selection scope under the tree | slice 2 smoke test | moves to slice 3 |
| Whether `+` needs a server route; today a session is a draft until the first send | start of slice 7 | slice 7 splits into an API and a UI pull request |
| A slice grows beyond about 700 review lines | before review | split it here first, then continue |
