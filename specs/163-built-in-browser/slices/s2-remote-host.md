# S2: Remote browser host on the laptop

Server route plus Electron host, no UI yet. Skills: `pichamber-change-discipline`, `desktop-shell`, `ui-api-decoupling`, `relay-transport`, `performance-engineering`.

## Acceptance criteria

- `GET /api/browser/status` answers `{ available: true }` when the server runs inside the desktop app and `{ available: false, reason: 'desktop-app-required' }` otherwise. Proof: route tests.
- `WS /api/browser/ws` requires PiChamber UI auth (scoped `oc_url_token`), is in both relay and URL auth allowlists, validates every client message and limits its size. Proof: route tests against the real auth and origin gates, allowlist tests.
- Through that socket a client opens the remote page, gets JPEG frames and page state (URL, title, back/forward, loading), and sends navigate, back, forward, reload, tap, scroll, text and key input. Proof: tests with a fake host, and a probe script against the running desktop app that loads a loopback only page and saves a received frame.
- The remote page runs in `persist:pichamber-browser` with the S1 policy, cancels downloads with a visible state message, and stops painting while no client is attached. Proof: unit tests of the Electron host with an injected webContents factory.

## Design

- `packages/electron/remote-browser-host.mjs`: one hidden offscreen `BrowserWindow` (`webPreferences.offscreen`, partition from the policy module, no preload). Frames from `paint`, encoded with `NativeImage.toJPEG`. Input through `webContents.sendInputEvent` and `insertText`. `enableDeviceEmulation` for the phone viewport. Fallback if offscreen painting misbehaves on Linux: CDP screencast through `webContents.debugger`, no dependency.
- One remote page, owner only. A new client takes over from the previous one. No painting without a client; the page closes after 10 minutes without a client and on quit.
- Flow control: one frame in flight, the client acknowledges each frame, the newest frame wins; about 15 fps cap, capped JPEG quality and device scale.
- `packages/web/server/lib/browser/` with `DOCUMENTATION.md`: owns auth, origin check, validation, size limits and the single client rule; rendering is delegated to an injected `remoteBrowserHost` passed through `startWebUiServer` (same pattern as `onDesktopNotification`). Without a host: `desktop-app-required`. Path added to `ALLOWED_WS_PATHS` (`relay/tunnel-host.js`) and the URL token allowlist (`ui-auth/ui-auth.js`).
- Wire format: JSON text for control and state, binary for JPEG frames. Client: `open {width,height,dpr}`, `navigate {url}`, `back`, `forward`, `reload`, `tap {x,y}`, `scroll {x,y,dx,dy}`, `text {value}`, `key {key}`, `ack`. Host: frame, `state {url,title,canGoBack,canGoForward,loading}`, `notice {kind}`, `unavailable {reason}`. Unknown message types are ignored, because phone and laptop may run different app versions.
