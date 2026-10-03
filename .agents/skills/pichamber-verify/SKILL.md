---
name: pichamber-verify
description: Use when recording, inspecting or publishing visual proof of PiChamber through the isolated lab.
---

# PiChamber verification

Read `lab/README.md` and `scripts/proof/DOCUMENTATION.md` before recording. Read `docs/workflow.md` before attaching proof to a pull request. Follow the approved plan and its acceptance criteria; do not use real projects, sessions or credentials.

## Proof steps

1. On the host, install with `bun install --frozen-lockfile` if needed and run `bun run build`. Commit source changes before the final recording: its report records the source SHA and dirty flag, and publishing refuses a source SHA differing from HEAD. Unit tests, type checks and lint stay on the host. Tests needing a separate environment run through `lab/run`.
2. Run `lab/run status` before `lab/run up`. A ready lab may belong to another checkout: inspect `podman pod inspect pichamber-lab --format '{{ index .Labels "io.pichamber.lab.checkout" }}'` and compare it with `pwd -P`. `status`, `record` and `down` refuse a foreign owner; run `lab/run down` from that owning checkout, never remove its resources blindly. For this checkout, recreate a stale lab after rebuilding changed executable source: `lab/run down`, then `lab/run up`. A new lab prints `http://127.0.0.1:3111`; `lab/run status` checks readiness. The fixtures are synthetic and the runtime is offline.
3. Run `lab/run record lab` (or the approved tour). Recording runs in the container with read-only source; only `.proof/` is writable on the host. Evidence failure exits nonzero with a not-proven report; fix the tour and repeat, never publish an incomplete run.
4. Open and inspect every PNG, the contact sheet and the whole video. For an agent, use the read tool on every image and extracted video frames covering the recording. Each view must show its caption, readable and uncovered; captions belong below the app. Check desktop/mobile and light/dark states that the plan asks for. A completed command alone is not proof. Record exactly what was viewed.
5. On the host, run `bun run proof:publish -- <pr> lab` only with the task's GitHub write authority. `--dry-run` validates and prepares without pushing; its output is explicitly unpublished. Publishing commits through a temporary worktree to the orphan `proofs` branch, under `pr-<n>/<tour>/`.
6. Paste the printed Markdown into the pull request's Verification with reproduction steps: fresh checkout, install/build, lab up, record, URL, what each view proves, and lab down. Check inline images and the video link on GitHub before claiming publication proven. Say that every image and the recording were inspected.
7. Run `lab/run down`, then `lab/run status` (must print `Lab is down.`). Explicitly check `! podman pod exists pichamber-lab`, `! podman container exists pichamber-lab-server`, `! podman container exists pichamber-lab-recorder`, `! podman network exists pichamber-lab` and `! podman volume exists pichamber-lab-state`. Cached images and local proof files intentionally remain.

## Extract video frames

With host ffmpeg, extract duration-covering samples into a temporary directory, not into the publishable tour directory:

```sh
frames=$(mktemp -d)
ffmpeg -v error -threads 2 -filter_threads 2 -i .proof/lab/video.mp4 -vf fps=1 "$frames/frame-%04d.png"
```

Read every PNG and the contact sheet, then all extracted samples. One frame per second covers the duration but is not full-motion playback; record exactly what was inspected and inspect the whole video where playback is available. Never claim that sampled frames prove every intermediate frame.

If host ffmpeg is absent, save `image=$(podman inspect pichamber-lab-server --format '{{.Image}}')` while the lab is up. Run the cleanup checks above first, then use its cached image in this bounded, foreground conversion container. Do not overlap it with the running lab or a recorder:

```sh
frames=$(mktemp -d)
podman run --rm --network=none --read-only --tmpfs=/tmp:rw,size=512m \
  --cpus=2 --memory=4096m --memory-swap=4096m --pids-limit=512 \
  --cap-drop=all --security-opt=no-new-privileges --userns=keep-id \
  --user "$(id -u):$(id -g)" --volume="$PWD/.proof:/proof:ro" \
  --volume="$frames:/frames:rw" "$image" ffmpeg -v error -threads 2 \
  -filter_threads 2 -i /proof/lab/video.mp4 -vf fps=1 /frames/frame-%04d.png
```

## Add an approved tour

Add the tour data in `scripts/proof/tours.mjs` and register it in that file's `builtinTours` allowlist. The separate shell allowlist is the top-level `record` argument guard in `lab/run`; add the same name there and update its `usage()` text. `validateTour` in `tours.mjs` defines allowed actions, evidence fields, names, viewports and themes; keep the tour inside that schema, with visible evidence matching each caption. Only the lab pod host and loopback URLs are accepted, including fixtures. Add source-named tests in `scripts/proof/tours.test.mjs` and the lab lifecycle tests. Run `bun run test:tools` and `bun run test:repo` on the host, then `lab/run record <tour>` and inspect its actual artifacts before publishing. Do not widen the allowlists or invent evidence without an approved plan.

## Validation

Run `bun run test` on the host before handoff. It includes lab and recorder unit suites without Podman, Chromium or ffmpeg. Run the additional checks required by the changed files. Keep failures, cleanup and retry behavior explicit in the evidence. Do not claim Electron or Capacitor proof from Chromium's hosted mobile emulation.
