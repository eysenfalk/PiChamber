# Context

Live context: what we know but have not settled yet. Every entry names its source, its date and what will settle it. The pull request that settles an entry, by a decision record, a document or code, removes it here ([ADR 0001](docs/adr/0001-decisions-and-live-context-in-separate-places.md)). Removed entries remain in the Git history.

## Integrations

### pi-subagents shows its async run status to RPC hosts as one versioned widget line

- Source: pi-subagents (`/home/feysen/projects/private/gh/pi-subagents`, read only): `src/runs/shared/async-status-projection.ts`, `src/runs/background/async-status-snapshot.ts`, `docs/observability.md`; observed in a real PiChamber session with a test extension on 2026-10-03
- Date: 2026-10-03
- Settled by: a decision record or a `DOCUMENTATION.md` of the Pi extension protocol that states which widget protocols the daemon supports, or pi-subagents changing the protocol

An RPC host receives the async status snapshot as widget `subagent-async`, line 0: `PI_SUBAGENT_ASYNC_JSON:` followed by JSON with `kind` `pi-subagents.async-status-snapshot` and `version` 1, capped at 32 KiB serialized. Hosts must not render the widget `subagent-inspect`; it carries on demand inspect replies. Before #30 the bridge and the public route projection cut every widget line at 2000 characters, which broke any larger snapshot; they now keep the `subagent-async` line 0 whole up to the cap. A new version, kind or node state makes the card show "Subagent status unavailable" until its parser learns it.

### Intent checkpoints rely on Pi extension behavior that is not proven yet

- Source: Pi 1.0.2 `docs/extensions.md` (`pi.appendEntry()`, `turn_end`) and `docs/session-format.md` (forks); `packages/web/server/lib/pi/session-daemon/DOCUMENTATION.md` (blocking extension dialogs); ADR 0006
- Date: 2026-10-05
- Settled by: the prototype in #70

Two things ADR 0006 assumes are untested. A blocking dialog opened from `turn_end` must stop the session cleanly, also while the agent wants to continue; the record now blocks only on hard changes, but those still need it. A fork at an entry must keep the `appendEntry` entries on its path, so a fork carries the checkpoints, rejections and confirmed relations up to its fork point; Pi 1.0.2 documents the parent link of a fork but not whether custom entries are copied.

## Release

### Releases of the fork are built locally, not by release.yml

- Source: `gh release list` and `gh run list --workflow release.yml` on `eysenfalk/PiChamber`; `gh secret list` (empty); `.github/workflows/release.yml`, `.github/workflows/mobile-release.yml`, `CONTRIBUTING.md` "Releases"
- Date: 2026-10-04
- Settled by: a decision record on how the fork releases, or Android signing secrets in GitHub and a first successful `release.yml` run

`CONTRIBUTING.md` describes releases by `release.yml` on a `vX.Y.Z` tag, building every desktop platform, Docker and the signed Android app from GitHub secrets. The fork has no Actions secrets and no successful `release.yml` run. Every release so far was built on the owner's machine: the APK signed with the local release key in `~/.config/pichamber/`, the AppImage with `bun run electron:build`, uploaded with `gh release create`. Their tags (`v1.0.3-android.1` to `v1.0.5-android.5`, `v1.0.6-build.6`) do not match the workflow's version pattern, so the triggered `release.yml` stops in `create-release` without building or publishing anything.

## Networking

### The owner's LAN address is not reachable from the phone, the Tailscale address is

- Source: session `01a0f83f` (2026-10-01): pairing over `http://192.168.178.95:39603` failed from the Android app while `http://100.120.83.24:39603` worked, ufw inactive; #46
- Date: 2026-10-01
- Settled by: finding the cause on the owner's network (router client isolation, a guest Wi-Fi or a host firewall) and documenting it in `connect-devices.mdx`

Pairing now defaults to Tailscale with an optional Wi-Fi fallback (#46), which avoids the problem but does not explain it. On a tested emulator the same LAN address and port were reachable over TCP (2026-10-05), so the server binds and listens correctly; the block sits between phone and host.

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
