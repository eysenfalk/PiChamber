# Context

Live context: what we know but have not settled yet. Every entry names its source, its date and what will settle it. The pull request that settles an entry, by a decision record, a document or code, removes it here ([ADR 0001](docs/adr/0001-decisions-and-live-context-in-separate-places.md)). Removed entries remain in the Git history.

## Integrations

### pi-subagents shows its async run status to RPC hosts as one versioned widget line

- Source: pi-subagents (`/home/feysen/projects/private/gh/pi-subagents`, read only): `src/runs/shared/async-status-projection.ts`, `src/runs/background/async-status-snapshot.ts`, `docs/observability.md`; observed in a real PiChamber session with a test extension on 2026-10-03
- Date: 2026-10-03
- Settled by: a decision record or a `DOCUMENTATION.md` of the Pi extension protocol that states which widget protocols the daemon supports, or pi-subagents changing the protocol

An RPC host receives the async status snapshot as widget `subagent-async`, line 0: `PI_SUBAGENT_ASYNC_JSON:` followed by JSON with `kind` `pi-subagents.async-status-snapshot` and `version` 1, capped at 32 KiB serialized. Hosts must not render the widget `subagent-inspect`; it carries on demand inspect replies. Before #30 the bridge and the public route projection cut every widget line at 2000 characters, which broke any larger snapshot; they now keep the `subagent-async` line 0 whole up to the cap. A new version, kind or node state makes the card show "Subagent status unavailable" until its parser learns it.

## Runtime

### The daemon was keyed to the package version, so a same-version rebuild kept the old daemon running

- Source: `packages/web/server/lib/pi/session-daemon/supervisor.js` reused a daemon when `state.buildId === paths.buildId`, and the server passed the package version as that ID; PR #40 (issue #39)
- Date: 2026-10-04
- Settled by: PR #40 merging (the build ID replaces the package version) and the live AppImage replacement run recorded in its description

A same-version AppImage replacement is only picked up when the relaunch uses `$APPIMAGE`, because `process.execPath` points into the old mount.

## Upstream

### The fork's workflow files differ from upstream

- Source: pull request #10 changes `AGENTS.md`, `CONTRIBUTING.md` and `.github/PULL_REQUEST_TEMPLATE.md`, which `RyderAsKing/PiChamber` also maintains
- Date: 2026-10-02
- Settled by: a decision record on how the fork follows upstream (merge, rebase or cherry-pick) and which files it keeps as its own

### Plan documents in docs/plans

- Source: `docs/plans/github-pull-requests-and-issues.md` ("Status: accepted", added in 6c1fe72a on 2026-09-27)
- Date: 2026-10-02
- Settled by: a pull request that moves its lasting decisions into a decision record or the owning `DOCUMENTATION.md` and deletes the file

The workflow keeps no archive of plans; plans live in pull requests and their squash commits.
