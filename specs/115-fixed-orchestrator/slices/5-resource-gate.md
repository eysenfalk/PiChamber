# Slice 5. Resource gate and lab lock

Part of #119. Depends on slice 4. Proposed role: `task-medium`.

## Contract

The orchestrator sees host load, available memory, workers against the limit and which workers are building, testing or using the lab. A spawn beyond the limit or over the host thresholds is refused with the reason. The lab has one holder at a time, visible, released when the holder ends or the lease times out.

## API seam

`orchestration/activity.js`, pure: `classifyCommand(command) → 'lab' | 'build' | 'test' | 'install' | null` (for example `lab/run`, `bun run build`, `bun test`, `bun run test`, `bun install`, `cargo build`). The watchdog records the classification of each running `bash` tool call of a registered worker in memory (live, not stored).

`host-info.js` gains `MemAvailable` from `/proc/meminfo` (fallback `os.freemem()`). `orchestration_capabilities` and the digest add:

```js
host: { cpuCount, loadAverage, memory: { availableBytes, totalBytes } },
activity: [{ sessionId, kind, command, since }],
gate: { open: boolean, reasons: string[] },
```

Spawn refuses with `ORCHESTRATION_LIMIT` when `activeWorkers()` across the daemon reaches `workerLimit`, and with `ORCHESTRATION_HOST_BUSY` when the 1 minute load exceeds the core count or available memory is below `orchestration.gate.minAvailableBytes` (default 8 GiB). Both carry the measured values. `orchestration.gate.enabled` switches the host check off; the limit always applies.

Lab lock in the registry: `lab: { holder: sessionId, since, expiresAt } | null`. New tools for workers and orchestrators:

- `lab_acquire { ttlMs? }` (default 30 min, max 2 h): grants when free, expired or already held by the caller (renews); otherwise `LAB_BUSY` with holder and expiry.
- `lab_release {}`: only the holder.
- The lease is released when its holder is stopped, removed or its record leaves `active`.

Guard: the orchestration extension's `tool_call` handler blocks a worker's `bash` call that `classifyCommand` marks `lab` with a `start`, `up` or `record` subcommand while the worker does not hold the lease, with the reason `Lab held by <title> until <time>; call lab_acquire.` Orchestrators and sessions outside the registry are not guarded.

## What the owner sees

Tests for limit, host refusal, acquire, refuse, renew, release, expiry and release on stop. Lab recording: two workers, the second's `lab/run up` is refused while the first holds the lease; the digest shows the holder.

## Gates

Focused tests with fake clock and fake `/proc` reads, `bun run test`, lab recording.

## Left to the implementer

The command patterns, the TTL defaults, whether `lab_release` is also offered to the orchestrator for a hung holder (then only for its own workers).

## Stays green

`lab/run` itself is unchanged; its pod check stays the hard stop.

## Feedback that changes this slice

Pi's `tool_call` cannot block with a reason: the guard becomes the refusal in `lab_acquire` and a rule in the skill, and the pull request says so.
