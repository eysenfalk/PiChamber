# S1: Desktop browser hardened and proven

Pull request #166.

## Acceptance criteria

- In the desktop app the owner opens the Browser surface, enters a URL, uses back, forward, reload and the address bar, logs into a site, quits and restarts the app, and is still logged in. Proof: recording of the real Electron app, with reproduction steps.
- Every `<webview>` is forced by the main process onto the partition `persist:pichamber-browser`, without preload, with `nodeIntegration` off, `contextIsolation` and `sandbox` on, and only `http:`/`https:`/`about:blank` URLs. Proof: unit tests for the policy module plus a probe page in the recording that shows no `pichamber*`/`__oc*` globals and no PiChamber cookie.
- Permission requests from the browser partition are denied except fullscreen and clipboard write. Proof: unit test of the handler and the probe page.

## Changes

- `packages/electron/browser-profile-policy.mjs` (new) with `browser-profile-policy.test.mjs` in `test:architecture`.
- `packages/electron/main.mjs`: `will-attach-webview` guard on every webContents, main frame scheme guard on webview guests (`will-navigate` and the guest's `loadURL`, which embedder loads use), permission handlers on the partition session at `whenReady`.
- `DesktopBrowserPane` is unchanged; the recording showed no gap.

## Finding

Before the guard on the guest's `loadURL`, the app renderer could load `file:///etc/passwd` into the webview through `<webview>.loadURL()`, because embedder initiated loads fire no `will-navigate`. The UI's `normalizeBrowserUrl` only filtered the address bar. The guard now rejects such loads in the main process.
