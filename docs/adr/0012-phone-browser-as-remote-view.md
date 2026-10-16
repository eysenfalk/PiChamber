# 0012. The phone browser is a remote view of a page the laptop renders in the PiChamber browser profile

- Status: Accepted
- Date: 2026-10-14

## Context

Issue #163 asks for a built-in browser for the owner, on desktop and on the phone, with persistent logins. Owner decisions recorded in the issue on 2026-10-14: logins live in one persistent browser profile owned by PiChamber; on the phone, pages go through the laptop, not the phone's network; owner only, no agent tool. The visited sites must never see PiChamber auth tokens.

State of `dev` at 49ca817c (2026-10-14): the desktop app already renders the Browser surface as an Electron `<webview partition="persist:pichamber-browser">`, without any main process policy for it. Outside Electron the same surface proxies external pages through `/api/preview/targets` with `allowExternal`, so they run inside PiChamber's origin; its own empty state warns that such pages have full access to PiChamber.

Alternatives considered (plan in PR #166):

- **Rewriting HTTP proxy through the PiChamber server:** keeps logins on the laptop only by syncing cookies into a server side jar, runs the page in PiChamber's origin unless a second origin is added that the relay cannot carry, and breaks with SSO redirects, CSP and SPAs.
- **Phone WebView with the laptop as network proxy:** logins live on the phone, which contradicts the single profile; needs native plugins per platform and cannot work in hosted mobile.

The owner approved the remote view on 2026-10-14 ("ja", quoted by the orchestrator in PR #166), with these answers: the phone reaches the desktop app over Tailscale; without a running desktop app only a visible hint is shown and nothing headless starts; the hosted web UI outside Electron uses the same remote view and the iframe proxy goes away; the profile denies all permissions except fullscreen and clipboard write; the inspect button of the desktop browser stays.

## Decision

- PiChamber has one browser profile, the Electron partition `persist:pichamber-browser` on the laptop. `packages/electron/browser-profile-policy.mjs` owns its rules, and the main process enforces them: no preload, no Node, sandbox and context isolation on, main frame loads only `http:`, `https:` and `about:blank`, every permission denied except fullscreen and sanitized clipboard writes.
- On desktop the page renders in a `<webview>` in that profile.
- Everywhere else (Capacitor app, hosted mobile, web outside Electron) the desktop app renders the page offscreen in the same profile and the client shows a live remote view over an authenticated PiChamber WebSocket: frames from the laptop, input from the client. Visited pages never run in PiChamber's origin.
- Without the desktop app behind the server, the Browser surface says so visibly. No headless browser is started.
- No agent tool, agent API or agent screenshot path reaches the browser.

## Consequences

- The phone reaches everything the laptop reaches, with the laptop's logins, and needs no new port or proxy.
- Phone ergonomics are those of a remote view: tap, scroll, keyboard button, some latency, and frame bandwidth over the relay or Tailscale.
- Sites that need camera, microphone, notifications or location do not get them in the PiChamber browser.
- The iframe proxy browser is removed (#169). The preview proxy keeps its `allowExternal` path only to inline cross origin images into Preview screenshots; it no longer shows external pages.
- A PiChamber UI session also reaches the owner's logged in sites; the remote browser routes therefore require UI auth like the terminal.

## Revisit when

The owner needs the browser without a running desktop app, a site the owner needs requires a denied permission, or remote view latency makes the phone browser unusable over the owner's connection.
