# 163: Built-in browser with persistent logins

Temporary spec ([ADR 0009](../../docs/adr/0009-spec-folder-for-multi-pr-features.md)). The last slice deletes this folder after moving the lasting rules into the owning documentation.

## Goal

The owner browses any website inside PiChamber with one persistent login profile owned by PiChamber, on the laptop. On desktop the page renders in the app. On the phone (Capacitor app and hosted mobile) the laptop's desktop app renders the page in that same profile and the phone shows a live remote view, so the phone reaches everything the laptop reaches. Visited sites never run in PiChamber's origin and never see PiChamber tokens. Owner only: no agent tool, no agent screenshots. Decision: [ADR 0012](../../docs/adr/0012-phone-browser-as-remote-view.md).

## Owner answers (2026-10-14, approval of PR #166)

1. The phone connects over Tailscale to the desktop app on the laptop.
2. Without a running desktop app the Browser surface only shows a visible hint. Nothing headless is started.
3. The hosted web UI outside Electron gets the same remote view; the iframe proxy browser goes away.
4. Browser profile permissions: everything denied except fullscreen and clipboard write.
5. The inspect button in the desktop browser stays as it is.
6. Phone proof comes from an Android emulator on the host; afterwards the owner tests live.

## Ladder

Each slice is its own pull request into `dev`, started after the previous one is merged.

| Slice | Content | State |
|---|---|---|
| [S1](slices/s1-desktop.md) | Desktop webview hardened by the main process, persistent login proven | PR #166 |
| [S2](slices/s2-remote-host.md) | Remote browser host in Electron, `/api/browser/*` routes, no UI | open |
| [S3](slices/s3-remote-ui.md) | Remote view UI for Capacitor, hosted mobile and web | open |
| [S4](slices/s4-cleanup.md) | Remove the iframe proxy browser, move rules into docs, delete this folder | open |

## Single owner rules

- `packages/electron/browser-profile-policy.mjs` owns the browser profile rules: partition name, allowed URL schemes, webview preferences and permissions. Every surface that renders visited pages (the `<webview>` and the S2 offscreen page) uses it; no second copy.
- `persist:pichamber-browser` is the only browser profile. It is never migrated or cleared by a slice, so a rollback keeps logins.
- Rendering and input of the remote page stay in Electron. Auth, origin checks, message validation and the single client rule stay in the web server route (S2). The shared UI only draws frames and sends input.
- Nothing in this feature is exposed to Pi, agent tools or the orchestration tools.

## Next agent prompt

Read this README, the slice file of your slice and ADR 0012. Branch from `origin/dev` after the previous slice is merged. Load the project skills the slice names. The plan of your pull request is its slice file plus the acceptance criteria copied from it; mark progress in the ladder above in your pull request.
