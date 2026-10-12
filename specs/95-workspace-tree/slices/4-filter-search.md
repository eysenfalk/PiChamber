# Slice 4. Visibility filter and quick search

Issue #97, closes it. Depends on slice 3 merged into `dev`.

Skills: `pichamber-change-discipline`, `sync-state-invariants`, `performance-engineering`, `theme-system`, `locale-ui-patterns`, `settings-ui-patterns` if it touches settings, `ui-api-decoupling` for the settings sync, `pichamber-verify`.

## Contract

The owner chooses which projects the tree shows, and one quick search finds projects, branches and session titles, including those in hidden projects.

## API seam

- New `stores/useProjectVisibilityStore.ts` with `hiddenProjectIds`, synced through desktop settings like the other UI settings, so the choice holds on desktop and web.
- Header button opens a checklist of all projects and Chats with All and None. Hidden projects stay registered.
- `buildWorkspaceTree` takes `hidden` and `query`. Matches add a transient expansion overlay; the stored expansion is never touched, so Esc drops the overlay and the query and restores the previous view. Hits in hidden projects show under their project, marked as hidden.
- The quick search replaces the session search (`useSessionSearchEffects`, `filterSessionNodesForSearch`), which is deleted.
- The catalog keeps loading hidden projects (D16); `buildKnownSessionDirectories` and `pi-session-catalog-feeder.tsx` are not filtered.

## Measurement

Row count and render time of a search that matches everything on real data. If it is too slow, a virtualization slice comes before this one merges.

## What the owner sees

Recording: hide two projects, search a branch name, a title in a hidden project, Esc.

## Gates

Focused tests, `type-check`, `lint`, `dead-code`, `bun run test`; recording looked at completely; `screenshot-critique` as the last check.

## Left to the implementer

Popover layout, debounce, match highlighting.
