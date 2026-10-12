# Slice 1. Registry, reservation and takeover

Part of #118. Depends on #110 (PR #112) merged, and on #107 (PR #113) merged or, if still open, stacked on `107-orchestration-mcp` as the README describes. Proposed role: `task-hard`.

## Contract

Which orchestrator owns which worker lives in a durable registry in the daemon. It survives compaction and daemon restart. A slot is reserved in the same transaction that checks the limit, so two concurrent spawns cannot both take the last one, and a crash between session creation and bookkeeping does not create a second worker on retry. One policy decides every tool call. A new orchestrator takes over all workers of an old one in one call.

## API seam

`orchestration/registry-store.js`, file `<dataDir>/pi/orchestration-registry.json`, atomic replace under the daemon's per-file lock helper, operations `read()` and `update(fn)` (serialised read, change, write). Unknown keys survive a write.

```js
{
  version: 1,
  importedFromLineage: ['<orchestratorSessionId>'],
  owners: { '<orchestratorSessionId>': { generation: 1 } },
  operations: {            // keyed `${orchestratorId}:${clientRequestId}`
    '<opId>': { kind: 'spawn' | 'start', orchestratorSessionId, intent, sessionId: null | string,
                state: 'reserved' | 'created' | 'failed' | 'abandoned', createdAt, steps?: {} },
  },
  workers: {
    '<workerSessionId>': {
      orchestratorSessionId, opId, cwd, title, role, model?, thinking?,
      issue?, branch?, worktree?, pullRequest?: { repo, number, headSha? },
      state, stateSince, createdAt,
      report?, question?, snapshot?,         // slice 2
      remedy?, github?, cleanup?,            // slices 5, 7, 9
    },
  },
  pendingEvents: {},                         // slice 3
}
```

State transitions (the only ones):

| From | Event | To |
|---|---|---|
| (op `reserved`) | session created and lineage written | `active` |
| (op `reserved`) | a start step fails (slice 8) | no worker; op `failed`, reservation released |
| `active` | worker reports `done` (slice 2) | `done` |
| `active`, `done` | `session_stop` | `stopped` |
| `done`, `stopped` | `session_send` or a UI prompt starts a run | `active`, only if the limit allows; otherwise refused with `ORCHESTRATION_LIMIT` |
| `done`, `stopped` | cleanup starts (slice 9) | `cleanup_pending`, then `removed` or `cleanup_blocked` |

An idle `active` worker keeps its slot; settle does not change the state. The limit counts reserved operations without a worker plus `active` workers, across the daemon.

Spawn path, shared by `session_spawn` now and `worker_start` in slice 8: one `update` checks policy, limit (and from slice 6 the host gate), then writes the operation `reserved`. Session creation writes `opId` into the worker's lineage entry. A second `update` moves the operation to `created` and adds the worker. On restart, and on a retry with the same `clientRequestId`, a `reserved` operation is reconciled: a session whose lineage carries the `opId` is adopted; none means the reservation is released and the spawn runs again. `inflightSpawns` stays only as an in-process guard.

Policy in `orchestration/policy.js`, called by the service for every tool after schema validation and before any side effect: caller kind (worker by lineage, orchestrator otherwise), tool's allowed caller kinds, and ownership of a target `sessionId` in the registry. `session_send` and `session_interrupt` keep #107's broad reach to any session; `session_stop` and every tool added by this epic need ownership.

New tool `orchestration_takeover { fromSessionId, clientRequestId? }`, orchestrator only. In one `update`: import `fromSessionId`'s JSONL child entries if not yet imported, move every worker not `removed` and every open operation to the caller, bump both owners' generation, and (from slice 3) move pending events. Refused with `ORCHESTRATION_TAKEOVER_BUSY` when `fromSessionId` is running.

Import of #107 JSONL child entries happens once per orchestrator, on its first use or on takeover, whichever comes first; stopped entries become `stopped`.

The spawn brief gets a short worker preamble from `instructions.js` (O15), because the extension does not inject instructions into workers. `instructions.js` and the skill say: bookkeeping is in PiChamber, `session_list` is the source after compaction, takeover exists.

## What the owner sees

No UI change. Daemon tests with the faux provider: two spawns racing for the last slot get one success and one `ORCHESTRATION_LIMIT`; a crash injected after session create and before the second `update` followed by a retry yields one worker; restart keeps workers and roles; takeover moves an idle and a `done` worker, then `session_stop` from the old orchestrator is refused over the inline and the MCP adapter; a worker calling an orchestrator-only tool is refused over both; an old JSONL-only orchestrator is imported once on takeover.

## Gates

Focused `bun test` on `registry-store.test.js`, `policy.test.js`, `orchestration-service.test.js`, `orchestration.e2e.test.js` and the MCP route tests; `bun run type-check`, `bun run lint`, `bun run dead-code`, then `bun run test`.

## Left to the implementer

File split inside `orchestration/`, error codes beyond the named ones, the wording of the worker preamble.

## Stays green

All #107 orchestration tests in intent, the MCP adapter, sessions created before this slice.

## Feedback that changes this slice

#113 merges with a different service shape: keep the registry daemon owned and adapt the seam here.
