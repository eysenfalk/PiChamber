# Slice 1. Registry and takeover

Part of #118. Depends on #107 (PR #113) merged into `dev`. Proposed role: `task-hard`.

## Contract

Which orchestrator owns which worker, and what the orchestrator knows about it, lives in a durable registry in the daemon. It survives compaction of the orchestrator and a daemon restart, and a new orchestrator session takes over the workers of an old one in one call. The #107 tools keep their names and behave the same from the orchestrator's view.

## API seam

New `packages/web/server/lib/pi/session-daemon/orchestration/registry-store.js`, file `<dataDir>/pi/orchestration-registry.json`, written by atomic replace under the daemon's existing per-file lock helper:

```js
{
  version: 1,
  importedFromLineage: ['<orchestratorSessionId>', ...],
  workers: {
    '<workerSessionId>': {
      orchestratorSessionId, cwd, title, role?, model?, thinking?,
      issue?: number, branch?, worktree?, pullRequest?: { number, url, headSha? },
      state: 'starting' | 'active' | 'done' | 'stopped' | 'start_failed'
           | 'cleanup_pending' | 'cleanup_blocked' | 'removed',
      stateSince: epochMs, createdAt, clientRequestId?,
      // filled by later slices; unknown keys survive a write
      report?, openQuestion?, usage?, start?, cleanup?,
    },
  },
  pendingEvents: { '<orchestratorSessionId>': [] },  // slice 3
  lab: null,                                         // slice 5
}
```

Store operations: `read()`, `update(fn)` (serialised read, change, atomic write), `workersOf(orchestratorId)`, `activeWorkers()` (state `starting` or `active`), `transfer(fromId, toId)`.

Changes in `orchestration-service.js`:

- spawn writes the registry record instead of `CHILD_ENTRY`; the worker still gets its lineage entry and Pi `parentSession` header.
- limits, `session_list`, `session_stop` and `onSessionSettled` read the registry. Delivery goes to the record's `orchestratorSessionId`, not the lineage parent.
- On first use of an orchestrator that has `CHILD_ENTRY` records and is not in `importedFromLineage`, import them once (stopped ones as `stopped`), then mark it imported.
- A `starting` record whose session has no live run after a restart becomes `active`, not busy.

New tool in `tool-contracts.js`, orchestrator only (`childAllowed: false`):

- `orchestration_takeover { fromSessionId, clientRequestId? }`: moves all non-terminal workers of `fromSessionId` to the caller and returns them. Refused when the caller is a worker, or when `fromSessionId` is itself live and busy (`ORCHESTRATION_TAKEOVER_BUSY`), so two live orchestrators never share a worker.

Update `instructions.js` and the `orchestrator` skill: bookkeeping is in PiChamber, `session_list` is the source after compaction, takeover exists.

## What the owner sees

Nothing in the UI. Daemon tests with Pi's faux provider show: an orchestrator spawns two workers, the daemon restarts, `session_list` returns both with their roles; a second orchestrator takes them over and receives the next result; an old JSONL-only orchestrator is imported once without duplicates.

## Gates

Focused `bun test` on `registry-store.test.js`, `orchestration-service.test.js`, `orchestration.e2e.test.js`; `bun run type-check`, `bun run lint`, `bun run dead-code`, then `bun run test`.

## Left to the implementer

File split inside `orchestration/`, the error code names beyond the ones above, whether `transfer` is an `update` call or its own function.

## Stays green

All #107 orchestration tests, unchanged in intent; sessions created before this slice keep working.

## Feedback that changes this slice

#113 merges with a different service shape or an MCP adapter: keep the registry daemon owned and adapt the seam here.
