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
const questionId = { type: 'string', minLength: 1, maxLength: 64 };
const RUN_STATUS = 'Each session reports state, the outcome and error of its last turn, and while it runs an activity object: runningForMs, quietForMs since its transcript last changed, retry with the provider error during an automatic retry, and waitingForInput when a dialog blocks it.';
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
          description: 'Model and thinking from the role defaults. orchestrate: the orchestrating session itself. plan: architecture, spec, plan. oracle: second opinion or advice before a decision, changes no code. debug: a stuck or hard bug. task-easy: clearly specified, 1-3 files, existing pattern, no contract changes, or a short text such as an issue or PR description. task-medium: clear goal, several files in one package, new tests, small design decisions, or larger documentation work. task-hard: across packages, contract change, sync, runtime or security, failure paths to think through. task-extreme: hours long, large refactors, several slices, state machines, concurrency. research: codebase or web research with sources. small: short mechanical work such as search, rename, summary, classification. review: check of finished work. When work turns out harder, escalate easy to medium to hard to extreme; a stuck bug goes to debug.',
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
    name: 'worker_start',
    label: 'Start worker for an issue',
    description: 'Start a worker for an issue in one call: fetch origin dev, create branchName from origin/dev, add its worktree at <worktreeRoot>/<branchName> and spawn the worker there with the role and brief. An existing branch is reused only while it points at origin/dev or is checked out at that path. A failure names the step and git\'s message and rolls nothing back; fix the cause and repeat the same call with the same clientRequestId to continue.',
    childAllowed: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['clientRequestId', 'issue', 'role', 'branchName', 'brief'],
      properties: {
        clientRequestId,
        issue: {
          type: 'object',
          additionalProperties: false,
          required: ['repo', 'number'],
          properties: {
            repo: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$', maxLength: 200, description: 'owner/repo' },
            number: { type: 'integer', minimum: 1 },
          },
        },
        role: { type: 'string', enum: [...ORCHESTRATION_ROLES], description: 'Model and thinking from the role defaults, as for session_spawn.' },
        branchName: {
          type: 'string',
          pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$',
          maxLength: 200,
          description: 'New branch, for example 118-worker-start; also the worktree directory name.',
        },
        brief: { type: 'string', minLength: 1, maxLength: 60000, description: 'Complete task brief for the worker.' },
        model,
        thinking,
      },
    },
  },
  {
    name: 'session_list',
    label: 'List sessions',
    description: 'List sessions. scope "workers" (default) lists this session\'s workers; "all" lists every live session. ' + RUN_STATUS,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { scope: { type: 'string', enum: ['workers', 'all'] } },
    },
  },
  {
    name: 'session_read',
    label: 'Read session',
    description: 'Read a session\'s state and its latest messages as text. ' + RUN_STATUS,
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
        resolves: { ...questionId, description: 'Id of the worker\'s open question this message answers; closes it once the message is accepted.' },
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
  {
    name: 'orchestration_takeover',
    label: 'Take over workers',
    description: 'Take over every worker and open start of another orchestrator session, for example after it was replaced. Refused while that session or one of its starts still runs. Retries of its starts with the same clientRequestId then reach you.',
    childAllowed: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['fromSessionId'],
      properties: { fromSessionId: { ...sessionId, description: 'The orchestrator session whose workers move to you.' }, clientRequestId },
    },
  },
  {
    name: 'orchestration_digest',
    label: 'Orchestration digest',
    description: 'The state of all your workers in one compact call, without opening dormant sessions: lifecycle, live state (busy, retry, waiting_input, idle, dormant), last progress and input, last report, open question, last error, usage at the last settle, pull request, and the slot use. Prefer it over session_read.',
    childAllowed: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { sessionIds: { type: 'array', minItems: 1, maxItems: 64, items: sessionId } },
    },
  },
  {
    name: 'worker_report',
    label: 'Report to orchestrator',
    description: 'Report your status to your orchestrator. progress: a step done. question or blocked (with audience): you need an answer; it stays open until a report or message names it in resolves. ready: a pull request is ready for review. done: the task is finished, with evidence and pullRequest or noPullRequest.',
    orchestratorAllowed: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'summary'],
      properties: {
        kind: { type: 'string', enum: ['progress', 'question', 'blocked', 'ready', 'done'] },
        summary: { type: 'string', minLength: 1, maxLength: 300, description: 'One line.' },
        audience: { type: 'string', enum: ['orchestrator', 'owner'], description: 'Who must answer; required for question and blocked.' },
        resolves: { ...questionId, description: 'Id of your open question this report settles.' },
        pullRequest: { type: 'integer', minimum: 1, description: 'Pull request number; required for ready.' },
        noPullRequest: { type: 'string', minLength: 1, maxLength: 300, description: 'Why done has no pull request.' },
        evidence: {
          type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 500 },
          description: 'Proof: tests, commands, results. Required for done.',
        },
        clientRequestId,
      },
    },
  },
];

export const ORCHESTRATION_TOOL_NAMES = ORCHESTRATION_TOOLS.map((tool) => tool.name);

export const qualifiedToolName = (name) => `${ORCHESTRATION_NAMESPACE}__${name}`;
