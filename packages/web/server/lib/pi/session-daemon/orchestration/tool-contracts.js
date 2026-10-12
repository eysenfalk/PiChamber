// One authoritative description of the orchestration tools. The in-process
// Pi extension (adapter A) and the MCP endpoint (adapter B) both project these
// contracts; parameters are plain JSON Schema, which Pi's TypeBox validator and
// MCP `tools/list` accept as is.

import { ORCHESTRATION_ROLES } from '../../settings-store.js';

export const ORCHESTRATION_NAMESPACE = 'mcp__pichamber';
export const ORCHESTRATION_MCP_SERVER = 'pichamber';

const sessionId = { type: 'string', minLength: 1, maxLength: 256, description: 'Target session id.' };
const clientRequestId = {
  type: 'string',
  // Shorter than a daemon send operation id: spawn derives `<id>.task` from it.
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$',
  description: 'Idempotency key. Use a new value per intent and the same value when retrying it.',
};
const thinking = { type: 'string', enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] };
const model = {
  type: 'object',
  additionalProperties: false,
  required: ['modelId'],
  properties: {
    providerId: { type: 'string', minLength: 1, maxLength: 256 },
    modelId: { type: 'string', minLength: 1, maxLength: 512 },
  },
};

export const ORCHESTRATION_TOOLS = [
  {
    name: 'orchestration_capabilities',
    label: 'Orchestration capabilities',
    description: 'List available models, role defaults, the worker limit, live workers (directory, branch, state) and host load and free memory. Call before delegating.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'session_spawn',
    label: 'Spawn worker session',
    description: 'Start a worker session in an absolute directory with a task. Returns the worker sessionId immediately; its result is delivered back to this session when it settles. mode "wait" additionally waits up to timeoutMs and never cancels the worker.',
    childAllowed: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['cwd', 'task'],
      properties: {
        cwd: { type: 'string', minLength: 1, maxLength: 4096, description: 'Absolute working directory of the worker.' },
        task: { type: 'string', minLength: 1, maxLength: 60000, description: 'Complete task brief for the worker.' },
        title: { type: 'string', minLength: 1, maxLength: 256 },
        role: {
          type: 'string',
          enum: [...ORCHESTRATION_ROLES],
          description: 'Model and thinking from the role defaults. plan: architecture, spec, plan, hard debugging. implement: multi-step change in a worktree, large refactor, longer than about 30 minutes. task: well-scoped everyday work such as a bug fix, small feature, docs or tests. research: codebase or web research with sources. small: short mechanical work such as search, rename, summary, classification. review: fresh review of a worker\'s changes.',
        },
        model,
        thinking,
        mode: { type: 'string', enum: ['async', 'wait'] },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 3600000 },
        clientRequestId,
      },
    },
  },
  {
    name: 'session_list',
    label: 'List sessions',
    description: 'List sessions. scope "workers" (default) lists this session\'s workers; "all" lists every live session.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { scope: { type: 'string', enum: ['workers', 'all'] } },
    },
  },
  {
    name: 'session_read',
    label: 'Read session',
    description: 'Read a session\'s state and its latest messages as text.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionId'],
      properties: { sessionId, limit: { type: 'integer', minimum: 1, maximum: 50 } },
    },
  },
  {
    name: 'session_send',
    label: 'Send to session',
    description: 'Send text to a session. delivery "prompt" (default) starts a run when idle, "steer" interrupts the current run after its tool calls, "followUp" queues after the current run.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionId', 'text'],
      properties: {
        sessionId,
        text: { type: 'string', minLength: 1, maxLength: 60000 },
        delivery: { type: 'string', enum: ['prompt', 'steer', 'followUp'] },
        clientRequestId,
      },
    },
  },
  {
    name: 'session_wait',
    label: 'Wait for sessions',
    description: 'Wait until the given sessions are idle or timeoutMs passes. Never cancels them. Returns each session\'s state and last reply.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionIds'],
      properties: {
        sessionIds: { type: 'array', minItems: 1, maxItems: 16, items: sessionId },
        until: { type: 'string', enum: ['all', 'any'] },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 3600000 },
      },
    },
  },
  {
    name: 'session_interrupt',
    label: 'Interrupt session',
    description: 'Abort the current run of a session. The session stays open.',
    parameters: { type: 'object', additionalProperties: false, required: ['sessionId'], properties: { sessionId } },
  },
  {
    name: 'session_stop',
    label: 'Stop worker',
    description: 'Abort one of your own workers, free its slot and stop its result delivery. Cascades to its workers.',
    childAllowed: false,
    parameters: { type: 'object', additionalProperties: false, required: ['sessionId'], properties: { sessionId } },
  },
];

export const ORCHESTRATION_TOOL_NAMES = ORCHESTRATION_TOOLS.map((tool) => tool.name);

export const qualifiedToolName = (name) => `${ORCHESTRATION_NAMESPACE}__${name}`;
