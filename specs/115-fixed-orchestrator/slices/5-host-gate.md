# Slice 5. Host gate and lab holder

Part of #119 (closed by slice 7). Depends on slice 2. Proposed role: `task-medium`. Size: 150 to 250 lines. Replaces the old slice 6 (resource gate and lab lease).

## Owner problem

The orchestrator checks `uptime` by hand before it starts a worker, and a lab left running by a worker whose worktree is gone blocks everyone else.

## Contract

A spawn or start is refused when the host is busy, with the numbers in the reason, and the digest shows the host numbers. The lab keeps its existing single holder (the checkout label on the pod), `lab/run status` names that holder, and a pod whose checkout no longer exists can be taken down from any checkout.

## API seam

- Gate in slice 1's reservation, after the limit check: read `/proc/loadavg` and `MemAvailable` through `host-info.js`. Refuse with `ORCHESTRATION_HOST_BUSY`, `details: { load1, cores, availableBytes, minAvailableBytes }` when `load1 > cores` or `availableBytes < minAvailableBytes`. Settings (O16): `orchestration.gate.enabled` (default on), `orchestration.gate.minAvailableBytes` (default 8 GiB).
- Digest: `host: { load1, cores, availableBytes, workers, limit }`, read live at the call.
- `lab/run`: `status` prints the holder from the pod label instead of the caller's path. `check_checkout` treats a pod whose labelled checkout directory no longer exists as abandoned, so `down` or `up` from another checkout removes it with the existing cleanup, under the existing `flock`.
- Worker preamble and skill: run `lab/run` only from your own worktree, run `down` when done, report `blocked` when the lab belongs to another checkout.

## What the owner sees

Gate tests with injected host numbers, a settings round trip, `lab-rules.test.mjs` assertions on the new `lab/run` text, `bash -n lab/run`. A host terminal transcript in the pull request: `lab/run up` from a second worktree is refused and names the first; after the first worktree is removed, `up` from the second succeeds.

## Bewusst nicht gebaut

- No lease file, no expiry and no `lease break`: `flock` plus the pod label already give one holder, and the holder ends with `down` or with its worktree.
- No command classifier and no `running` field in the digest: load and memory show whether the host is busy, and the gate refuses anyway.
- No lab holder in the digest; the orchestrator runs `lab/run status`.
- No lab recording of the refusal: the lab container has no podman.

## Gates

Focused tests, `lab-rules.test.mjs`, `bash -n lab/run`, `bun run test`.

## Stays green

Existing `lab/run` usage from one checkout and the existing checkout check.
