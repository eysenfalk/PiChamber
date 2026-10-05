# Proof lab

The web runtime from this checkout, with synthetic projects and Pi sessions, in rootless podman. Install, build, lint, type checks, unit tests, git and `gh` stay on the host. No model responses or credentials are needed.

```sh
bun install --frozen-lockfile
bun run build
lab/run up                  # prints http://127.0.0.1:3111
lab/run status
lab/run record lab           # captioned screenshots and H.264 video in .proof/lab/
lab/run record fork-rename   # renamed large fork listed by a fresh daemon, in .proof/fork-rename/
lab/run record add-device    # Add a device dialog without Tailscale, in .proof/add-device/
lab/run down                # removes pod, internal network and lab state volume
```

Requires Linux rootless podman with delegated cgroup v2 limits, a private `XDG_RUNTIME_DIR`, Node and Bun on the host. The lifecycle lock uses the runtime directory inode, so no writable lock file or symlink target is opened. The first `up` builds the image with network access. The image tag is the Containerfile hash. `up` refuses an existing pod; use `down` before rebuilding or resetting fixtures. Startup failure cleans up partial resources; cached images remain. Podman 5.7 can report a rootless netns permission error after deleting all containers. `down` retries removal only for an empty pod, at most three times, then verifies the pod, network and volume are gone. Failures with live containers are not retried or hidden. The pod is labeled with its checkout path. `status` prints that path; `status`, `record` and `down` refuse a lab owned by another checkout (or one without an ownership label). Run `down` from the owning checkout. `status` fails if an existing lab is unhealthy. Commands never prompt.

## Ownership and boundaries

`lab/run` owns the host lifecycle, `lab/lab.yaml` the pod contract, and `scripts/lab/seed.mjs` and `start.mjs` the fixture and server startup. `seed-manifest.json` is the recorder seam: project basenames, volume-local paths, and exact session titles match `SEED_MANIFEST` and are checked by `lab-rules.test.mjs`. `scripts/proof/` owns the recorder and host publisher; `record` starts a disposable container using the running server image on the same internal network, targeting only `http://pichamber-lab:3000/`. It accepts a tour name, not a URL or host environment overrides.

The server mounts only this repository, read-only at `/repo`. The recorder also mounts `.proof/` writable at `/repo/.proof`; no other host directory is writable. `record` checks checkout ownership before creating `.proof/` or a recorder container. The host supplies its commit SHA and dirty flag to `report.json`, because a worktree’s `.git` path need not be mounted in the recorder. Rebuild on the host and recreate the lab after executable source changes; ownership does not prove that already built UI assets match those changes. Its root filesystem is read-only; its HOME, browser profile and XDG state use disposable `/tmp` tmpfs, not the server state volume. Do not put credentials or real sessions in the checkout. All lab HOME, Pi, PiChamber and XDG state lives in `pichamber-lab-state` at `/lab`, not in the developer home. Sessions are written by the pinned SDK SessionManager into explicit cwd-scoped directories. The fresh seed creates three git repositories, short and long conversations, read/edit/bash successes and an expected bash failure, a linked subsession, a renamed fork of the long session, and distinct recency ages. Sessions are named before their first prompt. The fork is written by `SessionManager.forkFrom`, so its head carries the parent's title; it is then renamed and followed by 600 KiB of synthetic bash work, which reproduces issue #51 for the session list of a freshly started daemon. Reusing the volume preserves session identities; `down` discards it. An interrupted seed resets only manifest project names and lab agent sessions; other projects are preserved. Symlinked parent directories or an agent directory containing other state are refused before deletion.

The internal network has no internet route. The host port is published only on loopback. The server's unauthenticated LAN override applies only inside this pod, whose only published access is `127.0.0.1`; it does not change host server policy. Containers use keep-id, drop all capabilities and forbid privilege escalation. This prevents accidental host home access, not a kernel exploit. Any user or process that reaches `127.0.0.1:3111` can use the unauthenticated terminal to get a shell as the lab user inside the pod, with read access to the checkout.

The server gets 1.9 CPUs and 3968 MiB; infra gets 0.1 CPU and 128 MiB before pod startup; the recorder gets 2 CPUs, 4096 MiB and a 512 PID limit. Together: 4 CPUs and 8 GiB, no extra swap allowance. After starting the pod, `up` verifies the applied CPU quota/period, memory and swap limits with `podman inspect` for server and infra; ignored or mismatched limits fail startup and trigger cleanup. Server swap is derived from `lab.yaml`. The lifecycle lock prevents concurrent recorders and overlapping up/down/build operations. Image builds get at most 4 CPUs and 8 GiB and cannot overlap this lab through `run`'s lifecycle lock. Do not start separate recorder containers outside that budget.

The image has Ubuntu 26.04, Bun 1.4.2, Node 24, git, ffmpeg with libx264 and drawtext, and Chromium (Chrome for Testing 154.0.8037.92). Ubuntu's chromium package is a Snap transition package; pinned full Chrome for Testing avoids snapd in a rootless container. Only the container recorder uses `lab/chromium`, which adds `--no-sandbox`: capability dropping and no-new-privileges prevent the setuid sandbox, and nested namespace sandboxing is unavailable in this rootless environment. The read-only container and internal network remain the accidental-access boundary. Host recording and perf helpers never add this flag. The host's installed `node_modules` are used unchanged, and assets must be built on the host before `up`.

Projects are registered after daemon readiness through `/api/pi/projects/select`, and their UI settings through `/api/pi/ui-settings`, the same routes used by the UI. `projects.list` starts with only the server cwd; it does not discover every seeded session cwd automatically.

## Checks and proof

```sh
bun run test                # strips parent runtime selectors, keeps PICHAMBER_TEST_*
bun run test:tools           # SDK fixture, lifecycle, recorder and publisher; no podman
bun run test:repo            # image versions, budget, isolation contract, manifest
infra=$(podman pod inspect pichamber-lab --format '{{.InfraContainerID}}')
podman stats --no-stream "$infra" pichamber-lab-server pichamber-lab-recorder
# Run stats during recording, while the disposable recorder exists.
podman exec pichamber-lab-server sh -c 'test ! -e /home/feysen/.pi && test ! -e /home/feysen/.ssh && test ! -e /lab/.ssh'
podman exec pichamber-lab-server curl --connect-timeout 3 --max-time 5 https://example.com
# curl must fail; network probes do not authorize runtime internet access.
```

Open the printed URL. Select `Lab Alpha` (the prettified `lab-alpha` basename), then `Lab: long session with tools`; `lab-beta` contains `Lab: short session`. Check both desktop (1440×900) and mobile (390×844). Only synthetic lab text should be visible. Look at every saved image before publishing it. Inspect every PNG, the contact sheet and the recording, then publish from the host with `bun run proof:publish -- <pr> lab`. Captions sit below the app, never over it. `lab/run record fixture-broken` must fail on its missing `#clipped` evidence in the real lab; host fixture tests also cover actual clipping. Publishing and GitHub access never run inside the lab. [ADR 0004](../docs/adr/0004-proof-lab.md) records the decision.
