# 0004. Proof lab in rootless podman with synthetic SDK sessions

- Status: Accepted
- Date: 2026-10-03

## Context

The workflow requires reproducible visual proof, but a server on the developer host can see real sessions, SSH credentials and the internet. Issue [#11](https://github.com/eysenfalk/PiChamber/issues/11), opened 2026-10-02, identifies this accidental access and public proof risk. Environment variables alone are a convention, not a boundary.

The owner decided on 2026-10-02 that only work needing a separate environment runs in rootless podman, with an aggregate 4 CPU and 8 GiB budget. Install, builds, lint, type checks, unit tests, dev servers, git and GitHub remain on the host. The approved plan in [#12](https://github.com/eysenfalk/PiChamber/pull/12) seeds through the pinned Pi SDK rather than manufacturing JSONL. The sibling jira-connector sandbox supplied a read-only precedent for a hashed image and resource bounded rootless lifecycle (read 2026-10-03).

The approved plan rejected environment variables as isolation because they are conventions, not a boundary; running every command in a container because the owner explicitly kept normal development on the host; and microVMs (libkrun, microsandbox, BoxLite, boxd) because podman is the standard tool here.

## Decision

- Run the proof lab as a rootless pod on an internal network, with only the repository mounted read-only. Put HOME and all Pi and PiChamber state in a disposable lab volume. Publish only on host loopback, keep the caller's user ID, drop capabilities and forbid privilege escalation.
- Bound all lab runtime containers together to 4 CPUs and 8 GiB. Image builds use the same maximum budget and do not overlap the running lab. Repository tests check the aggregate limits and the versions pinned in the Containerfile against packageManager and CI (not the runtime versions of a built image).
- Write synthetic cwd-scoped sessions with the pinned SDK SessionManager: short and long conversations, successful and failed tools, a linked subsession and distinct ages. Register projects through existing public routes, without changing package source.
- Use one Ubuntu 26.04 image for the server and future recorder: Bun, Node, Chromium (pinned full Chrome for Testing, since Ubuntu Chromium requires Snap), git and ffmpeg with libx264 and drawtext. The recorder uses CDP plus ffmpeg, not a new Playwright dependency; captions go below the image.
- Store published proof on an orphan `proofs` branch and publish from the host. Recorder and publishing implementation follow in the stacked pull request. Every proof must be fully viewed before attaching.

## Consequences

The lab avoids accidental access to the developer's home and credentials, reproducibly demonstrates the actual web runtime, and keeps normal development on the host. Containers still share the host kernel; this is not hostile code isolation. The image build needs internet and disk space, while the running lab does not. Other local users can reach the loopback UI.

Matching Ubuntu glibc permits using the host's node_modules without another installation. If incompatible native modules are found on another host, the approved plan allows an isolated frozen-lockfile installation into a volume with a one-time network; that fallback must be proven before adding it. `down` discards seeded state; cached images remain. Rollback is reverting the tooling and running `lab/run down`.

## Revisit when

A required acceptance test needs live provider access, native modules fail on a supported host, or proof workloads cannot fit the agreed aggregate budget. Revisit the container boundary if untrusted code, rather than accidental access, becomes the threat model.
