# Remote browser route

This module lets a phone or web client use the owner's browser on the laptop (#163, [ADR 0012](../../../../../docs/adr/0012-phone-browser-as-remote-view.md)). The page renders in the desktop app, in the browser profile `persist:pichamber-browser`; this module only authenticates the client, validates its input and relays frames. Visited pages never run in PiChamber's origin and never see PiChamber tokens.

## Single owner rules

- `packages/electron/browser-profile-policy.mjs` owns the browser profile rules: partition name, allowed URL schemes, webview preferences and permissions. Every surface that renders visited pages (the desktop `<webview>` and the offscreen page of the remote host) uses it; there is no second copy.
- `persist:pichamber-browser` is the only browser profile. Nothing migrates or clears it, so a rollback keeps the owner's logins.
- Rendering and input of the remote page stay in Electron. Auth, origin checks, message validation and the one viewer rule stay in this route. The shared UI (`packages/ui/src/lib/browser/remoteBrowserClient.ts`, `RemoteBrowserPane.tsx`) only draws frames and sends input.
- No visited page runs in PiChamber's origin. The iframe proxy browser that did so is removed; the preview proxy's `allowExternal` path remains only for inlining cross origin images into Preview screenshots (`packages/ui/src/lib/preview/domAssetInlining.ts`).
- Nothing here is exposed to Pi, agent tools or the orchestration tools.

## Ownership

- `protocol.js` defines the socket path, the size limit and the client messages. `parseBrowserClientMessage` is the only way a client message reaches the host: it rejects non JSON, unknown types, out of range numbers, keys outside `BROWSER_KEYS` and URLs that are not `http:` or `https:`.
- `runtime.js` registers `GET /api/browser/status` and the `/api/browser/ws` upgrade and shuts the socket server down with the server.
- Rendering and input belong to the injected `remoteBrowserHost`. The Electron shell creates it (`packages/electron/remote-browser-host.mjs`) and passes it to `startWebUiServer`. Every other runtime passes nothing.

## Contract

- `GET /api/browser/status` answers `{ available: true }` with a host and `{ available: false, reason: 'desktop-app-required' }` without one. Without a host the upgrade is refused with 503. Nothing is started headless.
- The upgrade follows the STT runtime: UI session or scoped URL token, then the origin check, then registration with the live revocation coordinator, so a revoked principal loses the socket. The path is in both the URL token and the private relay allowlists.
- Client messages are JSON objects with a `type`: `navigate` (URL), `resize` (viewport), `tap`, `scroll`, `text`, `key` (from `BROWSER_KEYS`), `back`, `forward`, `reload`, `stop` and `ack`. They are JSON text of at most `BROWSER_MAX_CLIENT_MESSAGE_BYTES` (larger ones close the socket with 1009). Binary client messages and invalid messages get an `error` message and change nothing.
- The server sends binary messages with one JPEG frame each, and JSON text messages of type `state` (URL, title, back/forward, loading), `notice` (`download-blocked`, `page-crashed`) or `error`.
- One frame is in flight: the host sends the next frame only after the client's `ack`, at most about 15 per second, and drops paints in between. Without a client the page stops painting and closes after ten minutes.
- There is one viewer at a time. A new connection takes over the page and the previous one is closed with code 4001 (`BROWSER_REPLACED_CLOSE_CODE`).
- There is no agent path. Pi, the orchestration tools and agent screenshots have no access to this route or the host.
