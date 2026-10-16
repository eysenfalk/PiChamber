// One authoritative description of the orchestration tools. The in-process
// Pi extension (adapter A) and the MCP endpoint (adapter B) both project these
// contracts; parameters are plain JSON Schema, which Pi's TypeBox validator and
// MCP `tools/list` accept as is.

import { ORCHESTRATION_ROLES } from '../../settings-store.js';
import { TOOL_PROFILE_NAMES } from './tool-profiles.js';

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
const pullRequestRef = (description) => ({
  type: 'object',
  additionalProperties: false,
  required: ['repo', 'number'],
  description,
  properties: {
    repo: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$', maxLength: 200, description: 'owner/repo' },
    number: { type: 'integer', minimum: 1 },
  },
});
const RUN_STATUS = 'Each session reports state, the outcome and error of its last turn, and while it runs an activity object: runningForMs, quietForMs since its transcript last changed, retry with the provider error during an automatic retry, and waitingForInput when a dialog blocks it.';
const thinking = { type: 'string', enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] };
const profile = {
  type: 'string',
  enum: [...TOOL_PROFILE_NAMES],
  description: 'Tools the worker may use; the daemon blocks the rest. Default from the role: read-only for review and oracle, else full. read-only excludes edit, write, the writing AFT tools and subagents; bash stays, so it is a tool limit, not a sandbox.',
};
const excludeExtensions = {
  type: 'array',
  maxItems: 32,
  items: { type: 'string', minLength: 1, maxLength: 512 },
  description: 'Extensions the worker does not load, as patterns (* wildcard) on the extension path or package source such as npm:pi-intercom. PiChamber\'s own extensions always load.',
};
const model = {
  type: 'object',
  additionalProperties: false,
  required: ['modelId'],
  properties: {
    providerId: { type: 'string', minLength: 1, maxLength: 256 },
    modelId: { type: 'string', minLength: 1, maxLength: 512 },
  },
};

// The owner question the worker_report description shows;
// report-rules.test.js checks that it passes the contract and the owner rules.
export const OWNER_QUESTION_EXAMPLE = {
  kind: 'question',
  audience: 'owner',
  summary: 'Should the README check fail when the license section is missing?',
  brief: {
    context: 'I am building the README check for the release (issue #42). It checks the title and the install section; three old branches have no license section. How strict it is decides which tests I write now.',
    options: [
      { label: 'Fail', consequence: 'A release without a license is blocked; the three old branches turn red at once.', recommended: true },
      { label: 'Warn only', consequence: 'Everything stays green; a missing license shows up only in review.' },
    ],
    recommendation: 'Fail: a missing license blocks the release anyway, the check only says so earlier.',
    meanwhile: 'I keep writing the title and install tests; the license part waits.',
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
        profile,
        excludeExtensions,
        servesPr: pullRequestRef('For a helper without its own branch (review, research, oracle): the pull request it serves. worker_cleanup deletes the helper once that pull request is merged.'),
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
        profile,
        excludeExtensions,
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
    description: 'Read a session\'s state and the latest messages of its active branch as text, each with its entryId. ' + RUN_STATUS,
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
    name: 'session_rewind',
    label: 'Rewind worker',
    description: 'Move one of your own idle workers back to an earlier entry of its session (entry ids are in session_read), optionally prompting it from there in the same call. The session id stays; entries after the target leave the active branch, but file changes and commands of those entries are not undone. Refused while the worker runs or waits for input (ORCHESTRATION_SESSION_BUSY). Choosing a user message rewinds to just before it.',
    childAllowed: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionId', 'entryId'],
      properties: {
        sessionId,
        entryId: { type: 'string', minLength: 1, maxLength: 256, description: 'The session entry to move back to.' },
        prompt: { type: 'string', minLength: 1, maxLength: 60000, description: 'Sent to the worker after the rewind.' },
        clientRequestId,
      },
    },
  },
  {
    name: 'worker_cleanup',
    label: 'Clean up worker',
    description: 'After the owner merged a worker\'s pull request (pr_merged): remove its worktree (never forced), its local branch, its remote branch and its session, and forget the worker. Runs only when a merged pull request exists for exactly the worker\'s branch, its head is the local tip, the worktree is clean and no run is live; otherwise it removes nothing and returns the reason. Never main or dev. A helper spawned with servesPr loses only its session, once that pull request is merged. A failed step names itself; call again to continue.',
    childAllowed: false,
    parameters: { type: 'object', additionalProperties: false, required: ['sessionId'], properties: { sessionId } },
  },
  {
    name: 'worker_resolve',
    label: 'Close worker question',
    description: 'Close the open question or blocker of one of your own workers without sending it anything: no run starts, a dormant worker stays dormant, a stopped one stays stopped. Use it when the question is settled elsewhere, for example the owner answered it in your chat, or the worker is stopped. To answer and close in one step, use session_send with resolves.',
    childAllowed: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionId', 'questionId'],
      properties: {
        sessionId,
        questionId: { ...questionId, description: 'The open question to close, as listed in orchestration_digest.' },
        answeredBy: { type: 'string', enum: ['orchestrator', 'owner'], description: 'Who settled it, recorded in closedQuestion; owner when the owner answered in your chat. Default orchestrator.' },
      },
    },
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
    description: 'The state of all your workers in one compact call, without opening dormant sessions: lifecycle, live state (busy, retry, waiting_input, idle, dormant), last progress and input, last report, open question, the last closed question with who closed it, last error, usage at the last settle, pull request, and the slot use. Prefer it over session_read.',
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
    description: 'Report your status to your orchestrator. progress: a step done. question or blocked (with audience): you need an answer; it stays open until a report or message names it in resolves; a brief lays out the decision for whoever answers. ready: a pull request is ready for review. done: the task is finished, with evidence and pullRequest or noPullRequest. '
      + 'A question or blocked for the owner (audience owner) must be answerable from the decision inbox alone, where the owner answers by tapping an option, and is refused otherwise. Write it in the owner\'s language, one decision per report: summary is that decision or the blocker in one line; brief.context says what you do, where it stands and why the decision is needed now, with no internal shorthand the owner has not seen; brief.options has at least two answers, each with its consequence, exactly one recommended; brief.recommendation says which and why; brief.meanwhile says what you do or what stays blocked until the answer. A blocked also needs brief.tried and brief.needed; its options are optional. '
      + `Example: ${JSON.stringify(OWNER_QUESTION_EXAMPLE)}`,
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
        brief: {
          type: 'object',
          additionalProperties: false,
          // Which fields a brief needs (recommendation always, more for the owner) is checked by
          // report-rules.js, so one refusal names all of them; this schema checks types and bounds.
          description: 'Only for question and blocked: the decision laid out for whoever answers.',
          properties: {
            context: { type: 'string', minLength: 1, maxLength: 2000, description: 'What you are doing, where it stands and why the decision is needed now, understandable without anything else; for a blocker, its cause.' },
            options: {
              type: 'array',
              minItems: 1,
              maxItems: 6,
              description: 'The choices, each one an answer the owner can pick.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: { type: 'string', minLength: 1, maxLength: 120, description: 'Required: the answer as a short phrase.' },
                  consequence: { type: 'string', minLength: 1, maxLength: 500, description: 'What happens if this option is chosen.' },
                  recommended: { type: 'boolean', description: 'True for the one option you recommend.' },
                },
              },
            },
            recommendation: { type: 'string', minLength: 1, maxLength: 500, description: 'Required: what you recommend and why.' },
            counterargument: { type: 'string', minLength: 1, maxLength: 500, description: 'The strongest argument against your recommendation.' },
            revisit: { type: 'string', minLength: 1, maxLength: 300, description: 'When the decision should be looked at again.' },
            meanwhile: { type: 'string', minLength: 1, maxLength: 500, description: 'What you do, or what stays blocked, until the answer comes.' },
            tried: { type: 'string', minLength: 1, maxLength: 1000, description: 'Only for blocked: what you already tried.' },
            needed: { type: 'string', minLength: 1, maxLength: 500, description: 'Only for blocked: what you need from whoever answers.' },
          },
        },
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

/**
 * The tools a session of this kind is offered, by both adapters: a worker its
 * worker set, a marked orchestrator everything but `worker_report`, an
 * unmarked session none, so it pays no tokens for them. The service still
 * rejects forbidden calls on its own.
 * @param {'worker' | 'orchestrator' | 'unmarked' | undefined} kind
 */
export const toolsForKind = (kind) => {
  if (kind === 'worker') return ORCHESTRATION_TOOLS.filter((tool) => tool.childAllowed !== false);
  if (kind === 'orchestrator') return ORCHESTRATION_TOOLS.filter((tool) => tool.orchestratorAllowed !== false);
  return [];
};
