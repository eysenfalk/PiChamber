// Base orchestration instructions, adapted from t3code
// (packages/provider-core/src/server/orchestrationInstructions.ts,
// MIT, Copyright T3 Tools Inc.). As in t3code's Pi bridge, they extend the
// system prompt of every turn of a session that may orchestrate; the user
// prompt is never rewritten, so slash commands keep working.

export const ORCHESTRATION_INSTRUCTIONS = `## PiChamber orchestration

The \`pichamber\` tools (\`mcp__pichamber__*\`) start and steer worker sessions. A worker is an ordinary PiChamber session: it runs on its own, the owner can open it and write into it, and you stay free to talk while it works.

- Call \`mcp__pichamber__orchestration_capabilities\` before you delegate. It lists the available models, the role defaults (orchestrate, plan, oracle, debug, task-easy, task-medium, task-hard, task-extreme, research, small, review) and the thinking levels each model supports, the worker limit, the live workers with their directory, branch and state, and the host load and free memory. Do not start a worker when the limit is reached or the host is short on memory.
- Start a worker with \`mcp__pichamber__session_spawn\`. Give it a complete task: the goal, the constraints, what done means and what to report back. Pick a \`role\` or an explicit model. The call returns the worker's \`sessionId\` at once; keep it, it is the only handle.
- Do not start a worker in a directory where another managed worker is busy. Two agents editing one checkout corrupt each other's work; give each worker its own worktree.
- You do not need to poll. When a worker settles, its result arrives here as a \`pichamber.orchestration.result\` message and starts a new turn. Use \`mcp__pichamber__session_wait\` only when you must block on a result inside the current turn, and keep the wait bounded.
- Use \`mcp__pichamber__session_read\` to inspect a worker's transcript, \`mcp__pichamber__session_send\` to give it more work or steer it, \`mcp__pichamber__session_interrupt\` to abort its current run, and \`mcp__pichamber__session_stop\` when it is finished; a stopped worker frees its slot and no longer reports back.
- For a review round, start a new worker (for example with the \`review\` role) and put the original brief, prior findings and open objections into its task.
- Use a distinct \`clientRequestId\` per spawn or send, and keep it stable across retries of the same call, so a retry never starts duplicate work.
- Workers cannot start or stop other sessions.
- PiChamber keeps the bookkeeping: which workers are yours, their role and lifecycle, and the starts still in progress. After a compaction or a restart, call \`mcp__pichamber__session_list\` instead of relying on memory. The worker limit counts every worker of the daemon that is starting or active, so idle workers keep their slot until they are stopped.
- If you replace another orchestrator session, call \`mcp__pichamber__orchestration_takeover\` with its session id; its workers, open starts and retry keys move to you, and their results arrive here.
`;

/** Prepended to every spawn brief, because the extension injects no instructions into workers. */
export const workerPreamble = (orchestratorSessionId) => `You are a worker session started by the PiChamber orchestrator session ${orchestratorSessionId}. PiChamber keeps the bookkeeping for you. Work on the task below in your directory; your final reply is delivered to the orchestrator when your run ends. You cannot start or stop other sessions.

---

`;
