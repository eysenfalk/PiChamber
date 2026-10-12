# 0010. Orchestration through daemon-owned tools, an in-process adapter and a session-scoped MCP endpoint

- Status: Proposed
- Date: 2026-10-12
- Waits for: the owner confirms the design with the merge of #107

## Context

A session that delegates work through pi-subagents blocks inside the tool call, cannot be talked to while it waits and its workers exist only as transcripts (#107, 2026-10-12). The owner asked on 2026-10-12 for a PiChamber orchestration MCP taken from t3code (MIT, T3 Tools Inc.), with t3code style base instructions, at most four concurrent workers, and workers the owner can write into directly.

t3code (HEAD `701fc831`, `apps/server/src/mcp/`) runs one MCP endpoint per server. Each provider process gets a bearer token in its environment, minted per session with an expiry and revoked on release. Its Pi provider appends the orchestration instructions to the system prompt in `before_agent_start` on the first run, because wrapping the prompt breaks `/` commands.

PiChamber differs: all Pi sessions of a server share one daemon process (`packages/web/server/lib/pi/session-daemon/DOCUMENTATION.md`). A token in the process environment would be shared by every session and readable through `bash`.

Pi 1.1.0 accepts extension tools named `mcp__<server>__<tool>` (`docs/mcp.md`: `[A-Za-z0-9_]`), so in-process tools can carry the same names as tools of an MCP server called `pichamber`. Pi's native MCP client has a 60 second default request timeout (`docs/mcp.md`, 2026-10-12).

Alternatives considered:

- **MCP endpoint only, as in t3code:** needs a credential inside the shared daemon, which every session's `bash` could read.
- **A script that drives the HTTP API (#110):** a second source for roles and limits, and the parent still has to poll.

## Decision

- The daemon owns orchestration (`session-daemon/orchestration/`): lineage, the worker limit per orchestrator tree, idempotent spawn by `clientRequestId` and delivery of a worker's result to its parent as a `pichamber.orchestration.result` message. Workers are ordinary Pi sessions with `parentSession` set.
- Adapter A: every daemon runtime loads an inline extension that registers the eight tools as `mcp__pichamber__<tool>`. The caller is the runtime's own session, so there is no credential at all. The base instructions are appended to the system prompt on the first run of a session that has the tools, as t3code's Pi provider does.
- Adapter B: `POST /api/pi/mcp` serves the same tools over MCP Streamable HTTP (JSON responses, no event stream) for clients outside the daemon. It accepts only a credential minted by an authenticated client for one session (`POST /api/pi/sessions/:id/orchestration-credential`), kept as a SHA-256 hash in server memory with an eight hour lifetime, a 30 minute idle expiry and revocation on session deletion. The global `/api` gate lets such a bearer reach this one path, and only outside the tunnel scope.
- Both adapters call the same daemon operation (`orchestration.call`), which caps waits at 50 seconds so a call stays under the native MCP timeout.
- Role to model mapping and the worker limit (default 4) live only in the PiChamber settings sidecar.

## Consequences

- A session can delegate and keep talking; the owner sees workers nested in the sidebar and can write into them.
- No orchestration secret exists inside the daemon process.
- Credentials do not survive a server restart; an external client mints a new one.
- `session_wait` returns before long workers finish, so callers wait again or rely on the result delivery.

## Revisit when

Pi runs sessions in separate processes, Pi's MCP client gains long-running requests, or a second orchestration client needs a credential that survives restarts.
