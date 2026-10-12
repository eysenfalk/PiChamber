# Slice 6. Resource gate and lab lease

Part of #119 (closed by slice 7). Depends on slice 4. Proposed role: `task-hard`.

## Contract

A spawn over the worker limit or over the host thresholds is refused with a clear reason. The lab has one holder at a time, visible to everyone, and nobody else can start, stop or record it while the lease is valid, whoever runs `lab/run`.

## API seam

Gate in the spawn reservation of slice 1: after the limit check, read `/proc/loadavg` and `MemAvailable` from `/proc/meminfo` (`host-info.js`, which #107 already uses). Refuse with `ORCHESTRATION_HOST_BUSY` and `details: { load1, cores, availableBytes, minAvailableBytes }` when `load1 > cores` or `availableBytes < minAvailableBytes`. Settings (O16): `orchestration.gate.enabled` (default on), `orchestration.gate.minAvailableBytes` (default 8 GiB).

`orchestration/activity.js`: pure `classifyCommand(command) → 'build' | 'test' | 'install' | 'lab' | 'other'`, used by the digest (`running: [{ class, since }]` per worker from live tool events).

Lab lease in `lab/run`, under the `flock` it already takes:

- File `${XDG_RUNTIME_DIR}/pichamber-lab.lease`, one JSON line `{ checkout, pid, since, expiresAt }`. `checkout` is the repository root that ran `up`, the same value as the pod label `io.pichamber.lab.checkout`.
- `up` refuses with `Lab leased by <checkout> since <since> until <expiresAt>` when a valid lease names another checkout. It writes the lease only after the pod is up and its limits are verified; a failed `up` runs the existing cleanup and leaves no lease, so lease and pod never name different holders. `up` again from the holder renews it.
- `record` and `down` from another checkout are refused the same way, before any container is created or removed. `down` from the holder removes the lease.
- A lease expires after `PICHAMBER_LAB_LEASE_SECONDS` (default 7200) from its last `up` or `record`. A lease whose pod no longer exists is free.
- Handoff after expiry, all under the same `flock`: `up` or `down` from another checkout first removes the expired holder's pod, network and volume with the existing cleanup, checking the pod label against the lease's `checkout` instead of the caller's. If that removal fails, the command refuses, the expired lease stays and `status` shows it with the failure; nothing is started. Only after the old pod is gone does `up` continue as above. `record` from another checkout stays refused, because there is no pod of its own to record.
- A pod without a lease (from before this slice, or after `lease break`) keeps today's rule: only its checkout label may touch it.
- `lab/run status` prints the holder. `lab/run lease break` removes the lease, for the owner.

The daemon only reads the lease file for the digest (`lab: { checkout, since, expiresAt } | null`). It holds no lease and adds no tools. The worker preamble and the skill say: run `lab/run` only from your own worktree; a refusal names who holds it; report `blocked` instead of breaking it.

## What the owner sees

`lab-rules.test.mjs` cases with a fake `podman` and a temp runtime dir: acquire, refusal from a second checkout for `up`, `record` and `down`, renew by the holder, release on `down`, expiry with the old pod still running followed by `up` from a second checkout (old pod removed, new lease), the same with a failing removal (refused, old lease kept), `up` failing after the pod started (rollback, no lease), a stale lease without a pod, a pod without a lease, `lease break`. Gate tests with injected host numbers. The lab container has no podman and mounts the checkout read-only, so the refusal cannot be recorded inside the lab. Proof instead: a host terminal transcript, quoted in the pull request, where `lab/run up` from a second worktree is refused with the first one's checkout and succeeds after the first runs `down`; plus a lab recording of the digest showing the holder from a lease file the tour writes into the lab's own runtime dir.

## Gates

`lab-rules.test.mjs`, gate and classifier tests, `bash -n lab/run`, `bun run test`, the recording.

## Left to the implementer

Shell structure in `lab/run`, the classifier's pattern list.

## Stays green

Existing `lab/run` usage for a single checkout; existing pod checkout check.

## Feedback that changes this slice

#119 asks for a lab proof of the refusal. The host transcript replaces it; the orchestrator asks the owner to accept that before slice 7 closes #119 (README, Issue closing).
