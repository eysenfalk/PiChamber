import { ORCHESTRATION_INSTRUCTIONS } from './instructions.js';
import { ORCHESTRATION_NAMESPACE, ORCHESTRATION_TOOLS, qualifiedToolName, toolsForKind } from './tool-contracts.js';
import { toolAllowed } from './tool-profiles.js';

// Adapter A: an inline Pi extension the daemon adds to every session runtime.
// The runtime already knows which session calls a tool, so no credential is
// involved. t3code instead hands each Pi process a bearer token in its
// environment; PiChamber sessions share one daemon process, where such a token
// would be shared by all sessions and readable through `bash`.

const ORCHESTRATION_EXTENSION_NAME = 'pichamber-orchestration';

const ALL_TOOLS = new Set(ORCHESTRATION_TOOLS.map((tool) => qualifiedToolName(tool.name)));

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
 * @param {{ call: Function, sessionKind: (sessionManager) => Promise<'worker' | 'orchestrator' | 'unmarked'>,
 *   sessionProfile: (sessionManager) => object | null | undefined }} service
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
    // orchestrators never see worker_report; unmarked sessions see none. The
    // service rejects forbidden calls independently. The kind is decided again
    // before every run: a worker's lineage entry may arrive after its
    // session_start, and a mark may be set or removed between runs. A failed
    // settings read counts as unmarked until the next run. A worker's tool
    // profile (#151) also drops its excluded tools here, so the model is not
    // sent their schemas.
    const applyKind = async (ctx) => {
      const kind = await service.sessionKind(ctx.sessionManager).catch(() => 'unmarked');
      const profile = service.sessionProfile(ctx.sessionManager);
      const active = pi.getActiveTools();
      const allowed = [...active.filter((name) => !ALL_TOOLS.has(name)), ...toolsForKind(kind).map((tool) => qualifiedToolName(tool.name))]
        .filter((name) => toolAllowed(profile, name));
      const current = new Set(active);
      if (allowed.length !== current.size || allowed.some((name) => !current.has(name))) pi.setActiveTools(allowed);
      return kind;
    };

    pi.on('session_start', async (_event, ctx) => {
      await applyKind(ctx);
    });

    // The enforcement: every tool call, from the model or nested in another
    // tool (`ctx.executeTool`, Fabric's captured tools), passes this hook.
    // A tool activated after `applyKind` is still blocked, and a throw here
    // blocks the call too.
    pi.on('tool_call', async (event, ctx) => {
      const profile = service.sessionProfile(ctx.sessionManager);
      if (toolAllowed(profile, event.toolName)) return undefined;
      return {
        block: true,
        reason: profile
          ? `This worker runs with the tool profile "${profile.name}", which excludes ${event.toolName}.`
          : `This worker's tool profile cannot be read, so only reading tools run; ${event.toolName} is blocked.`,
      };
    });

    // Like t3code's Pi bridge: the base instructions extend the system prompt
    // of every turn of a marked orchestrator. They never enter the transcript,
    // and the first user message stays untouched so slash commands still expand.
    pi.on('before_agent_start', async (event, ctx) => {
      if (await applyKind(ctx) !== 'orchestrator') return undefined;
      return { systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATION_INSTRUCTIONS}` };
    });
  },
});
