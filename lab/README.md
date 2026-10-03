# Proof lab

The web runtime from this checkout, with synthetic projects and Pi sessions, in rootless podman. Install, build, lint, type checks, unit tests, git and `gh` stay on the host. No model responses or credentials are needed.

```sh
bun install --frozen-lockfile
bun run build
lab/run up                  # prints http://127.0.0.1:3111
lab/run status
lab/run down                # removes pod, internal network and lab state volume
```

Requires Linux rootless podman with delegated cgroup v2 limits, Node and Bun on the host. The first `up` builds the image with network access. The image tag is the Containerfile hash. `up` refuses an existing pod; use `down` before rebuilding or resetting fixtures. Startup failure cleans up partial resources; cached images remain. Podman 5.7 can report a rootless netns permission error after deleting all containers. `down` retries removal only for an empty pod, at most three times, then verifies the pod, network and volume are gone. Failures with live containers are not retried or hidden. `status` fails if an existing lab is unhealthy. Commands never prompt.

## Ownership and boundaries

`lab/run` owns the host lifecycle, `lab/lab.yaml` the pod contract, and `scripts/lab/seed.mjs` and `start.mjs` the fixture and server startup. `seed-manifest.json` is the recorder seam: project basenames, volume-local paths, and exact session titles match `SEED_MANIFEST` and are checked by `lab-rules.test.mjs`. A later writer adds `record` as another `lab/run` case, not another lab instance.

Only this repository is mounted, read-only at `/repo`. Do not put credentials or real sessions in the checkout. All lab HOME, Pi, PiChamber and XDG state lives in `pichamber-lab-state` at `/lab`, not in the developer home. Sessions are written by the pinned SDK SessionManager into explicit cwd-scoped directories. The fresh seed creates three git repositories, short and long conversations, read/edit/bash successes and an expected bash failure, a linked subsession, and distinct recency ages. Reusing the volume preserves session identities; `down` discards it. An interrupted seed is retried from fresh fixture directories.

The internal network has no internet route. The host port is published only on loopback. The server's unauthenticated LAN override applies only inside this pod, whose only published access is `127.0.0.1`; it does not change host server policy. Containers use keep-id, drop all capabilities and forbid privilege escalation. This prevents accidental host home access, not a kernel exploit. Other users on this host can access the loopback UI.

The server container, including a future recorder run with `podman exec`, gets 3.9 CPUs and 8064 MiB. Infra gets 0.1 CPU and 128 MiB before pod startup. Together: 4 CPUs and 8 GiB, no extra swap allowance. Image builds get at most 4 CPUs and 8 GiB and cannot overlap this lab through `run`'s lifecycle lock. Do not start separate recorder containers outside that budget.

The image has Ubuntu 26.04, Bun 1.4.2, Node 24, git, ffmpeg with libx264 and drawtext, and Chromium (Chrome for Testing 154.0.8037.92). Ubuntu's chromium package is a Snap transition package; pinned full Chrome for Testing avoids snapd in a rootless container. Use `chromium --headless=new` for the recorder. The host's installed `node_modules` are used unchanged, and assets must be built on the host before `up`.

Projects are registered after daemon readiness through `/api/pi/projects/select`, and their UI settings through `/api/pi/ui-settings`, the same routes used by the UI. `projects.list` starts with only the server cwd; it does not discover every seeded session cwd automatically.

## Checks and proof

```sh
bun run test                # clears inherited PiChamber/Electron environment for all suites
bun run test:tools           # SDK fixture round trip, lifecycle decisions; no podman
bun run test:repo            # image versions, budget, isolation contract, manifest
podman stats --no-stream pichamber-lab-server
podman exec pichamber-lab-server sh -c 'test ! -e /home/feysen/.pi && test ! -e /home/feysen/.ssh && test ! -e /lab/.ssh'
podman exec pichamber-lab-server curl --connect-timeout 3 --max-time 5 https://example.com
# curl must fail; network probes do not authorize runtime internet access.
```

Open the printed URL. Select `lab-alpha`, then `Lab: long session with tools`; `lab-beta` contains `Lab: short session`. Check both desktop (1440×900) and mobile (390×844). Only synthetic lab text should be visible. Look at every saved image before publishing it. The recorder, captions below the image and publication to the orphan `proofs` branch arrive in the stacked pull request; this lab does not publish files. [ADR 0004](../docs/adr/0004-proof-lab.md) records the decision.
