import { OrchestrationError } from './errors.js';
import { ORCHESTRATION_TOOLS } from './tool-contracts.js';

// One decision for every orchestration tool call, after schema validation and
// before any side effect: may this caller kind use the tool, and does the
// caller own the target session where the tool needs ownership. #107's
// `session_send` and `session_interrupt` keep their reach to any session.

const workerAllowed = new Map(ORCHESTRATION_TOOLS.map((tool) => [tool.name, tool.childAllowed !== false]));
const OWNERSHIP_TOOLS = new Set(['session_stop']);

/**
 * @param {{ toolName: string, callerSessionId: string, callerKind: 'worker' | 'orchestrator',
 *   targetOwner?: string | null }} call targetOwner is the registry owner of
 *   `args.sessionId`, or null when the session is no registered worker.
 */
export const authorize = ({ toolName, callerSessionId, callerKind, targetOwner }) => {
  if (callerKind === 'worker' && !workerAllowed.get(toolName)) {
    throw new OrchestrationError('ORCHESTRATION_FORBIDDEN', `Workers cannot call ${toolName}.`);
  }
  if (OWNERSHIP_TOOLS.has(toolName) && targetOwner !== callerSessionId) {
    throw new OrchestrationError('ORCHESTRATION_FORBIDDEN', 'Only your own workers can be stopped.');
  }
};

export const needsOwnership = (toolName) => OWNERSHIP_TOOLS.has(toolName);
