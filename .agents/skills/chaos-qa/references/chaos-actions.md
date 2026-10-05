# Chaos actions

Load when planning way 2. Pick the actions that hit the charter; each one names how to cause it in the lab.

## Driving the browser

Use `scripts/perf/cdp.mjs` (`resolveChrome`, `reservePort`, `launchChrome`, `createPageTarget`, `CdpClient`, `evaluateValue`) from a script under `/tmp/chaos-qa/<run>/`. Host Chrome against `http://127.0.0.1:3111` stays sandboxed. Set the viewport with `Emulation.setDeviceMetricsOverride` and the theme through the app's settings, as the recorder does. Collect `Runtime.consoleAPICalled`, `Runtime.exceptionThrown` and failed `Network` events for the whole run.

Click with `Input.dispatchMouseEvent` at the element's center, not `element.click()`: synthetic clicks in one evaluation all land before React re-renders, which exaggerates spam results. Sample toasts and state every few hundred milliseconds instead of once, because toasts expire. Wait until the app is ready (a known control is visible) before judging a page; a fixed sleep after reload or restart produces false "missing" and splash-screen results. `[role=dialog]` also matches the Settings dialog itself.

## Catalogue

| Class | Actions | How in the lab |
|---|---|---|
| Input abuse | double click, click spam, Enter spam, submit while a dialog opens, keyboard-only, paste huge text, empty and whitespace input, unicode and RTL, emoji, markdown and HTML injection | `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText` |
| Interruption | close a dialog mid-action, navigate away mid-request, reload during every step of a flow, press back on mobile | `Page.reload`, `Page.navigate`, history API |
| Network | offline and back, slow 3G, offline only during a write, drop the WebSocket | `Network.emulateNetworkConditions`, `Network.setBlockedURLs` for one route |
| Server and daemon faults | kill the session daemon, kill it mid-turn or mid-reload, hang the whole server, restart the server | `podman exec pichamber-lab-server pkill -f daemon-process`; `podman pause pichamber-lab-server` then `podman unpause`; restart only through the product's own controls or `lab/run down`/`up` |
| Concurrency | two tabs on one session, act in both, one deletes what the other edits, switch sessions during streaming | two CDP page targets, or two browser profiles for separate logins |
| State and time | stay idle past the five-minute daemon unload, leave a tab in background, change system theme mid-flow, resize desktop to mobile mid-flow | wait with the timebox in mind; `Emulation.setDeviceMetricsOverride` |
| Data | very long sessions, many projects, malformed settings or extension payloads, names with spaces, quotes and unicode | edit lab state with `podman exec`, only under `/lab` |
| Auth | no cookie, expired cookie, wrong origin | separate profile; raw `curl` against `127.0.0.1:3111` |

Do not fill disks, change host networking or kill anything outside the lab pod.

## When the lab cannot run it

Live model turns, the desktop shell, the AppImage and pairing need a host instance. Start it isolated and say so in the report:

```sh
run=/tmp/chaos-qa/<run>
mkdir -p "$run/data" "$run/agent"
PICHAMBER_DATA_DIR="$run/data" PICHAMBER_PI_AGENT_DIR="$run/agent" \
  node packages/web/bin/cli.js serve --foreground --host 127.0.0.1 --port <free port>
```

Use a free port other than 39603, a fresh browser profile under `$run`, and stop the server and its daemon at the end. Start it with `setsid nohup ... &`, write `$!` to `$run/pid-<port>`, and find its daemon by `PICHAMBER_DATA_DIR` in `/proc/<pid>/environ`. A host instance requires the UI login: set `PICHAMBER_UI_PASSWORD` to a throwaway value and log in with `curl -c "$run/jar" -H 'content-type: application/json' -d '{"password":"<value>"}' http://127.0.0.1:<port>/auth/session`.

A shell started inside Pi or PiChamber already carries `INVOCATION_ID` and other desktop session variables. Probes that depend on the environment must state which variables they set or unset. A real model provider in `$run/agent` needs the owner's approval first. Desktop and AppImage chaos needs the owner's approval because it can collide with the running desktop app.

## Replay

Every run keeps `$run/actions.jsonl`: one line per action with timestamp, seed, target and parameters. A finding's reproduction steps come from this log, cut down to the shortest sequence that still fails.
