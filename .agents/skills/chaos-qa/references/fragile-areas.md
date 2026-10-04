# Fragile areas

Load when writing the charter. Each entry is a place where PiChamber broke before or depends on something outside its control, with the attack that would have found it. Add an entry when a chaos-qa run finds a new class of bug.

## Process and environment detection

- **Environment heuristics.** `INVOCATION_ID` is set for every process in a systemd user session, including terminals and the AppImage, so it does not prove a process manager will restart anything (PR #40). Attack: read `/proc/<pid>/environ` of a terminal-started server, the AppImage and a real systemd unit; compare with what the code infers.
- **Electron as Node.** Child processes under `ELECTRON_RUN_AS_NODE=1` must use `process.execPath`; system Node cannot read `app.asar` and fails with `ENOTDIR`. Attack: start any child-process feature from the packaged AppImage, not from a checkout.
- **Source versus build versus AppImage.** Paths, build stamps and resources differ per launch mode. Attack: run the same flow from a checkout, a web build and the AppImage.
- **Windows and macOS.** Mostly unchecked on this machine; list them as unchecked cells rather than assuming parity.

## Session daemon lifecycle

- **Idle unload after five minutes.** Unloading stops in-process watchers; results delivered while unloaded are stored without a new turn. Attack: leave a session idle past five minutes during background work, then check what arrives live.
- **Subagent residency.** Sessions stay loaded while `subagent-async` snapshots show active runs, capped at six hours. Attack: finish, fail or corrupt the snapshot and check the session unloads; kill the subagent process and check it does not stay resident forever.
- **Daemon restart and replacement.** Stream epoch changes, sessions must resync, the build ID decides reuse. Attack: kill the daemon mid-turn and mid-reload; start two servers against one data dir; replace the build and restart.
- **Load-sensitive timing.** Timeouts tuned on an idle machine fail under load (the Windows probe test in `supervisor.test.js` fails at load 7). Attack: run the flow while the host is busy.

## Live state versus reload

- **Turns without a user message.** Pi starts turns without a `parentId` (subagent results, extensions); live rendering once dropped them while reload showed them (PR #38). Attack: trigger an unsolicited turn while the session stays open and untouched; compare with the transcript before any reload.
- **Reload and session switch hide bugs.** Both rebuild state from the server. Attack: always capture the live view first, then reload and diff.
- **Fetch failure as empty.** A failed request must not render as an empty list. Attack: make the request fail (offline, killed daemon, 500) and check the UI shows an error, not "no sessions".

## Extension and bridge surfaces

- **Size limits.** The extension bridge once truncated status at 2000 characters while pi-subagents sends up to 32 KiB. Attack: push statuses, widgets and messages at and past every documented limit.
- **Malformed extension data.** Raw JSON snapshots, unknown status keys, partial updates. Attack: send invalid and truncated payloads; the UI must degrade to text, not crash.
- **UI caches of Pi resources.** Skills, prompts and slash commands are cached in the UI; a server-side reload once left the UI list stale (PR #40). Attack: change resources, reload, check every surface that lists them.

## Transport, clients and auth

- **Reconnect.** WebSocket and SSE reconnect after server, daemon or network loss. Attack: go offline mid-stream, come back, check for duplicates, gaps and stuck spinners.
- **Several clients.** Desktop, browser and phone on one server. Attack: act on the same session from two clients at once.
- **Pairing and reachability.** LAN may be unreachable while Tailscale works; relay is the fallback. Attack: pair with each candidate unreachable in turn (host-instance only).
- **Authentication.** Every `/api/*` route needs the UI login. Attack: call new routes without the cookie, with an expired one, and from a paired device.

## Double activation

- **Buttons disabled through state.** A disabled flag set by a reducer applies only after the next render, so a double click fires the action twice; confirm buttons without an in-flight guard do the same (#67, Reload Pi and Restart confirm). Attack: two real mouse clicks 80 ms apart on every action button and dialog confirm, then check requests and toasts.

## Settings and persistence

- **Settings round trip.** Missing versus empty, malformed files, concurrent writes. Attack: corrupt the settings file in the lab state, toggle quickly, reload.
