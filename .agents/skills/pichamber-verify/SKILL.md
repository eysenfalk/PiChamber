---
name: pichamber-verify
description: Use when recording, inspecting or publishing visual proof of PiChamber through the isolated lab.
---

# PiChamber verification

Read `lab/README.md` and `scripts/proof/DOCUMENTATION.md` before recording. Read `docs/workflow.md` before attaching proof to a pull request. Follow the approved plan and its acceptance criteria; do not use real projects, sessions or credentials.

## Proof steps

1. On the host, install with `bun install --frozen-lockfile` if needed and run `bun run build`. Unit tests, type checks and lint stay on the host. Tests needing a separate environment run through `lab/run`.
2. Run `lab/run up`. It prints `http://127.0.0.1:3111`; `lab/run status` checks readiness. The fixtures are synthetic and the runtime is offline.
3. Run `lab/run record lab` (or the approved tour). Recording runs in the container with read-only source; only `.proof/` is writable on the host. Evidence failure exits nonzero with a not-proven report; fix the tour and repeat, never publish an incomplete run.
4. Open and inspect every PNG, the contact sheet and the whole video. For an agent, use the read tool on every image and extracted video frames covering the recording. Each view must show its caption, readable and uncovered; captions belong below the app. Check desktop/mobile and light/dark states that the plan asks for. A completed command alone is not proof. Record exactly what was viewed.
5. On the host, run `bun run proof:publish -- <pr> lab` only with the task's GitHub write authority. `--dry-run` validates and prepares without pushing; its output is explicitly unpublished. Publishing commits through a temporary worktree to the orphan `proofs` branch, under `pr-<n>/<tour>/`.
6. Paste the printed Markdown into the pull request's Verification with reproduction steps: fresh checkout, install/build, lab up, record, URL, what each view proves, and lab down. Check inline images and the video link on GitHub before claiming publication proven. Say that every image and the recording were inspected.
7. Run `lab/run down` and verify no named lab pod, network or volume remains. Cached images and local proof files intentionally remain.

## Validation

Run `bun run test` on the host before handoff. It includes lab and recorder unit suites without Podman, Chromium or ffmpeg. Run the additional checks required by the changed files. Keep failures, cleanup and retry behavior explicit in the evidence. Do not claim Electron or Capacitor proof from Chromium's hosted mobile emulation.
