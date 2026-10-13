import { ORCHESTRATION_INSTRUCTIONS } from './instructions.js';
import { ORCHESTRATION_NAMESPACE, ORCHESTRATION_TOOLS, qualifiedToolName } from './tool-contracts.js';

// Adapter A: an inline Pi extension the daemon adds to every session runtime.
// The runtime already knows which session calls a tool, so no credential is
// involved. t3code instead hands each Pi process a bearer token in its
// environment; PiChamber sessions share one daemon process, where such a token
// would be shared by all sessions and readable through `bash`.

const ORCHESTRATION_EXTENSION_NAME = 'pichamber-orchestration';

const CHILD_FORBIDDEN_TOOLS = new Set(
  ORCHESTRATION_TOOLS.filter((tool) => tool.childAllowed === false).map((tool) => qualifiedToolName(tool.name)),
);

const formatResult = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  details: value,
});

const toToolError = (error) => {
  if (error?.code) {
    const details = error.details ? `\n${JSON.stringify(error.details, null, 2)}` : '';
    return new Error(`${error.code}: ${error.message}${details}`);
  }
  return error instanceof Error ? error : new Error(String(error));
};

/**
 * @param {{ call: Function, isWorker: (sessionManager) => boolean }} service
 */
export const createOrchestrationExtension = (service) => ({
  name: ORCHESTRATION_EXTENSION_NAME,
  hidden: true,
  factory: (pi) => {
    const namespace = {
      name: ORCHESTRATION_NAMESPACE,
      description: 'PiChamber orchestration: start, steer and collect worker sessions.',
    };
    for (const tool of ORCHESTRATION_TOOLS) {
      pi.registerTool({
        name: qualifiedToolName(tool.name),
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        namespace,
        exposure: 'direct',
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          try {
            const callerSessionId = ctx.sessionManager.getSessionId();
            return formatResult(await service.call(callerSessionId, tool.name, params, { signal }));
          } catch (error) {
            throw toToolError(error);
          }
        },
      });
    }

    // Workers keep read/list/send/wait/interrupt but never see spawn or stop;
    // the service rejects those calls independently.
    const restrictWorker = (ctx) => {
      if (!service.isWorker(ctx.sessionManager)) return false;
      const active = pi.getActiveTools();
      const allowed = active.filter((name) => !CHILD_FORBIDDEN_TOOLS.has(name));
      if (allowed.length !== active.length) pi.setActiveTools(allowed);
      return true;
    };

    pi.on('session_start', (_event, ctx) => {
      restrictWorker(ctx);
    });

    // Like t3code's Pi bridge: the base instructions extend the system prompt
    // of every turn of a session that may orchestrate. They never enter the
    // transcript, and the first user message stays untouched so slash commands
    // still expand.
    pi.on('before_agent_start', (event, ctx) => {
      if (restrictWorker(ctx)) return undefined;
      return { systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATION_INSTRUCTIONS}` };
    });
  },
});
