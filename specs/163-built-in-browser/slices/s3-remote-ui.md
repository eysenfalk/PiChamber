# S3: Remote browser UI on phone and web

Skills: `pichamber-change-discipline`, `ui-api-decoupling`, `relay-transport`, `performance-engineering`, `theme-system`, `locale-ui-patterns`, `pichamber-verify`.

## Acceptance criteria

- Capacitor app: a Browser tab in the workspace drawer shows the remote view with address bar, back, forward, reload, tap, scroll and a keyboard button. Proof: recording on an Android emulator on the host connected to the laptop's desktop app, opening a site only the laptop reaches, already logged in from desktop. Afterwards the owner tests live over Tailscale.
- Hosted mobile and web outside Electron: the Browser surface uses the same remote view. Proof: recording of hosted mobile against the desktop app's server.
- Where no desktop app hosts the server, the Browser surface says visibly that the browser needs the PiChamber desktop app on the laptop. A failed status fetch shows an error, not this hint. Proof: lab recording of hosted mobile and web showing that state.

## Design

- `packages/ui/src/components/browser/RemoteBrowserPane.tsx` and a small client in `packages/ui/src/lib/browser/`: socket through `openRuntimeWebSocket` after `refreshRuntimeUrlAuthToken()`, frames drawn on a canvas, touch mapped to tap and scroll, a keyboard button that focuses a hidden input, reconnect with backoff.
- `mobileWorkspaceTabs.ts` and `MobileWorkspaceDrawer.tsx` get the Browser tab; `BrowserPane.tsx` picks the remote pane outside Electron.
- Parity notes in `packages/ui/src/apps/DOCUMENTATION.md` and `packages/mobile/README.md`.
