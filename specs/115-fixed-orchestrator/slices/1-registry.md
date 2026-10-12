# Slice 1. Registry, reservation and takeover

Part of #118. Depends on #110 (PR #112) merged, and on #107 (PR #113) merged or, if still open, stacked on `107-orchestration-mcp` as the README describes. Proposed role: `task-hard`.

Precondition, checked before the plan of this slice is written: the role enum in #113's `orchestration/tool-contracts.js`, the role defaults and tests in its `settings-store.js`, and #112's `orchestrator` skill use exactly the eleven names `orchestrate`, `plan`, `oracle`, `debug`, `task-easy`, `task-medium`, `task-hard`, `task-extreme`, `research`, `small`, `review`. If any of them differs, stop and report to the orchestrator; this slice adds no role names.

## Contract

Which orchestrator owns which worker lives in a durable registry in the daemon. It survives compaction and daemon restart. A slot is reserved in the same transaction that checks the limit and is held until the worker's last run has settled, so neither two concurrent spawns, nor a `done` report inside a running turn, nor a prompt to a finished worker can exceed the limit. A start survives a crash at every step, including the window in which Pi has not yet written the session to disk. One policy decides every tool call. A new orchestrator takes over all workers and open operations of an old one in one call.

## API seam

`orchestration/registry-store.js`, file `<dataDir>/pi/orchestration-registry.json`, atomic replace under the daemon's per-file lock helper, operations `read()` and `update(fn)` (serialised read, change, write). Unknown keys survive a write. One daemon owns one registry file; in-process locks below rely on that.

```js
{
  version: 1,
  importedFromLineage: ['<orchestratorSessionId>'],
  owners: { '<orchestratorSessionId>': { generation: 1 } },
  requestKeys: { '<orchestratorId>:<clientRequestId>': '<opId>' },   // lookup only
  operations: {            // keyed by a generated opId that never changes
    '<opId>': { kind: 'spawn' | 'start', orchestratorSessionId, clientRequestId, intent,
                sessionId: null | string, state: 'reserved' | 'created' | 'failed' | 'abandoned',
                step, steps: {}, error?: { step, message, at }, createdAt, stateSince },
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

Steps of every spawn, journalled in `steps` before and after each runs (slice 8 adds `branch` and `worktree` in front):

1. `reserved`: policy, limit (from slice 6 also the host gate), operation written. No side effect yet.
2. `session`: session created with the `opId` in its lineage entry; in the same `update` the worker is added with state `starting`.
3. `prompted`: the brief was accepted by the daemon's input path (receipt `messageId` recorded).
4. `durable`: the session's JSONL exists on disk. Pi writes it only with the first assistant message, so a session that never got one vanishes on restart (`session-daemon.js`, comment before `runSessionInput`). The check is the one idle disposal already uses: `stat` of `sessionManager.getSessionFile()`; success is durable, `ENOENT` is positively absent, anything else is unknown.

State transitions (the only ones):

| From | Event | To |
|---|---|---|
| op `reserved` | step `session` done | worker `starting`, op `created` |
| op `reserved` | a step fails (slice 8) | no worker; op `failed`, reservation released, `start_failed` to the op's owner (slice 3) |
| `starting` | a settle or the restart check finds the JSONL | `active` |
| `starting` | a settle or the restart check finds it positively absent | worker removed, op back to `reserved` at step `session`, slot kept; a retry or restart recreates the session in the same place |
| `starting` | the check is unknown | stays `starting`, shown in the digest, checked again on the next tick |
| `active` | the run in which the worker reported `done` settles (slice 2) | `done` |
| `active` | `session_stop`, after its abort settled | `stopped` |
| `done` | `session_stop` | `stopped` |
| `done`, `stopped` | any input that starts a run | `active`, in the same `update` as the limit check; otherwise refused with `ORCHESTRATION_LIMIT` |
| `done`, `stopped` | cleanup starts (slice 9) | `cleanup_pending`, then `removed` or `cleanup_blocked` |

The limit counts operations in `reserved` plus workers in `starting` and `active`, across the daemon. A `done` report does not free a slot: the run that made it may still call tools; the slot frees when that run settles (B2). An idle `active` worker keeps its slot.

Input gate: the daemon's `runSessionInput` is the one path for UI prompts and `session_send` alike. Before it activates a session, it calls `orchestration.beforeSessionInput(sessionId)`; for a registered worker in `done` or `stopped` that one `update` reserves the slot and moves it to `active`, or refuses. Steer and follow-up into a running worker need no slot.

Retry and restart: a call with a `clientRequestId` looks up `requestKeys['<caller>:<clientRequestId>']` and resumes that operation at its first unfinished step. Every step's write checks that the operation still belongs to the caller; after a takeover a late write of the old call fails with `ORCHESTRATION_OWNER_CHANGED` and that call stops. On restart: a `reserved` operation whose `opId` is in some session's lineage adopts that session, otherwise its reservation is released (spawn) or kept for a retry (start, slice 8); `starting` workers are checked as in the table. `inflightSpawns` stays only as an in-process guard against concurrent calls with the same key.

Policy in `orchestration/policy.js`, called by the service for every tool after schema validation and before any side effect: caller kind (worker by lineage, orchestrator otherwise), tool's allowed caller kinds, and ownership of a target `sessionId` in the registry. `session_send` and `session_interrupt` keep #107's broad reach to any session; `session_stop` and every tool added by this epic need ownership.

New tool `orchestration_takeover { fromSessionId, clientRequestId? }`, orchestrator only. Refused with `ORCHESTRATION_TAKEOVER_BUSY` while `fromSessionId` is running, while a step of one of its operations runs in this process, or (slice 3) while a delivery to it runs. Otherwise, in one `update`: import `fromSessionId`'s JSONL child entries if not yet imported, move every worker not `removed` and every open operation to the caller, add `requestKeys` for the caller with the same `clientRequestId` and the same `opId`, bump both owners' generation, and (slice 3) move pending events.

Import of #107 JSONL child entries happens once per orchestrator, on its first use or on takeover, whichever comes first; stopped entries become `stopped`, the others `active`.

The spawn brief gets a short worker preamble from `instructions.js` (O15), because the extension does not inject instructions into workers. `instructions.js` and the skill say: bookkeeping is in PiChamber, `session_list` is the source after compaction, takeover exists.

## What the owner sees

No UI change. Daemon tests with the faux provider and the real session manager:

- two spawns racing for the last slot: one success, one `ORCHESTRATION_LIMIT`;
- a crash after session create and before the worker write, then a retry: one worker;
- a crash after the worker write and before the first assistant message: after restart the JSONL is absent, the operation is `reserved` again with its slot, a retry gives one durable worker;
- a `done` report while the turn is held open by a blocked tool, and a concurrent spawn for the last slot: refused until the turn settles;
- a UI prompt and a `session_send` to two `done` workers racing for the last slot: one starts, one is refused;
- restart keeps workers and roles;
- takeover moves an idle and a `done` worker; `session_stop` from the old orchestrator is then refused over the inline and the MCP adapter; a worker calling an orchestrator-only tool is refused over both;
- a partial start, takeover, a retry from the new owner with the same `clientRequestId` and a late write of the old call: one operation, the old write refused;
- an old JSONL-only orchestrator is imported once on takeover.

## Gates

Focused `bun test` on `registry-store.test.js`, `policy.test.js`, `orchestration-service.test.js`, `orchestration.e2e.test.js` and the MCP route tests; `bun run type-check`, `bun run lint`, `bun run dead-code`, then `bun run test`.

## Left to the implementer

File split inside `orchestration/`, error codes beyond the named ones, the wording of the worker preamble, the `opId` format.

## Stays green

All #107 orchestration tests in intent, the MCP adapter, sessions created before this slice, UI prompts to sessions that are not workers.

## Feedback that changes this slice

#113 merges with a different service shape: keep the registry daemon owned and adapt the seam here. `session_send` does not reach `runSessionInput`: put the input gate on its path too, never in the UI. The slice exceeds 600 lines: split takeover into its own pull request.
