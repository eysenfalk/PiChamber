import { execFile } from 'node:child_process';

import { ORCHESTRATION_INSTRUCTIONS } from './instructions.js';
import { factKey, judgeCommand } from './merge-guard.js';
import { ORCHESTRATION_NAMESPACE, ORCHESTRATION_TOOLS, qualifiedToolName, toolsForKind } from './tool-contracts.js';
import { toolAllowed } from './tool-profiles.js';

// Adapter A: an inline Pi extension the daemon adds to every session runtime.
// The runtime already knows which session calls a tool, so no credential is
// involved. t3code instead hands each Pi process a bearer token in its
// environment; PiChamber sessions share one daemon process, where such a token
// would be shared by all sessions and readable through `bash`.

const ORCHESTRATION_EXTENSION_NAME = 'pichamber-orchestration';

const ALL_TOOLS = new Set(ORCHESTRATION_TOOLS.map((tool) => qualifiedToolName(tool.name)));

// The merge guard's lookups (#20) run with a deadline and never prompt; their
// output is a branch or base name, and only the first line of an error is kept.
const LOOKUP_TIMEOUT_MS = 10_000;
const SHELL_TOOLS = new Set(['bash', 'powershell']);
const PULL_BASE_BY_ID_QUERY = 'query($id: ID!) { node(id: $id) { ... on PullRequest { baseRefName } } }';

/**
 * @typedef {(file: string, args: string[], cwd: string) => Promise<{ code: number | string, stdout: string, stderr: string }>} RunLookup
 * @type {RunLookup}
 */
const runLookupCommand = (file, args, cwd) => new Promise((done) => {
  execFile(file, args, {
    cwd,
    timeout: LOOKUP_TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
  }, (error, stdout, stderr) => {
    const code = !error ? 0 : error.killed ? 'timed out' : (error.code ?? 'failed');
    done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});

const lookupError = ({ code, stderr }) => {
  const line = stderr.split('\n').map((text) => text.trim()).find(Boolean);
  return (line ?? (typeof code === 'number' ? `exit ${code}` : String(code))).slice(0, 200);
};

// `git config` exits 1 without output when nothing is set.
const readConfig = async (run, args, dir) => {
  const read = await run('git', ['config', ...args], dir);
  if (read.code === 1 && !read.stdout.trim()) return { lines: [] };
  if (read.code !== 0) return { error: lookupError(read) };
  return { lines: read.stdout.split('\n').map((line) => line.trim()).filter(Boolean) };
};

const GIT_FALSE = /^(false|no|off|0)$/i;

/** Answers one need of `judgeCommand` as `{ value }` or `{ error }`; never throws. */
const lookupFact = async (need, cwd, run) => {
  try {
    if (need.fact === 'branch') {
      const head = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], need.dir);
      // Exit 1 without output: a detached HEAD, which tracks nothing.
      if (head.code === 1 && !head.stdout.trim()) return { value: { branch: null, upstream: null } };
      if (head.code !== 0) return { error: lookupError(head) };
      const branch = head.stdout.trim();
      const tracked = await run('git', ['for-each-ref', '--format=%(upstream:remoteref)', `refs/heads/${branch}`], need.dir);
      if (tracked.code !== 0) return { error: lookupError(tracked) };
      return { value: { branch, upstream: tracked.stdout.trim().replace(/^refs\/heads\//, '') || null } };
    }
    if (need.fact === 'pushConfig') {
      const pushDefault = await readConfig(run, ['--get', 'push.default'], need.dir);
      if (pushDefault.error) return { error: pushDefault.error };
      const remotes = await readConfig(run, ['--get-regexp', '^remote\\..*\\.(push|mirror)$'], need.dir);
      if (remotes.error) return { error: remotes.error };
      // `remote.<name>.push <refspec>` or `remote.<name>.mirror [<bool>]`; a mirror counts unless it is false.
      const settings = remotes.lines.map((line) => line.match(/^(\S+)\s*(.*)$/)).filter(Boolean);
      return { value: {
        pushDefault: pushDefault.lines.at(-1)?.toLowerCase() ?? null,
        mirror: settings.some(([, key, value]) => key.endsWith('.mirror') && !GIT_FALSE.test(value)),
        refspecs: settings.filter(([, key]) => key.endsWith('.push')).map(([, , value]) => value),
      } };
    }
    const read = need.fact === 'pullBase'
      ? await run('gh', ['pr', 'view', ...(need.selector ? [need.selector] : []), ...(need.repo ? ['--repo', need.repo] : []),
        '--json', 'baseRefName', '--jq', '.baseRefName'], need.dir)
      : await run('gh', ['api', 'graphql', '-f', `query=${PULL_BASE_BY_ID_QUERY}`, '-f', `id=${need.id}`,
        '--jq', '.data.node.baseRefName'], cwd);
    if (read.code !== 0) return { error: lookupError(read) };
    const base = read.stdout.trim();
    return base ? { value: base } : { error: 'no base branch was returned' };
  } catch (error) {
    return { error: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
  }
};

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
 * @param {{ runLookup?: RunLookup }} [options] `runLookup` runs the merge guard's
 *   `git` and `gh` lookups; tests replace it.
 */
export const createOrchestrationExtension = (service, { runLookup = runLookupCommand } = {}) => ({
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

    // The merge guard (#20, `merge-guard.js`): a worker or marked orchestrator
    // may not merge into or push to main through a shell command. Most
    // commands pass the pure check without any read; only a command it cannot
    // decide reads the session kind and then the facts it names. A failed kind
    // read guards too (fail closed), and so does a failed fact lookup.
    const guardMerges = async (event, ctx) => {
      const command = event.input?.command;
      if (!SHELL_TOOLS.has(event.toolName) || typeof command !== 'string') return undefined;
      const options = { cwd: ctx.cwd, shell: event.toolName };
      let verdict = judgeCommand(command, options);
      if (verdict.decision === 'allow') return undefined;
      const kind = await service.sessionKind(ctx.sessionManager).catch(() => 'unknown');
      if (kind === 'unmarked') return undefined;
      if (verdict.decision === 'need') {
        // Every need gets a value or an error, so this verdict is final.
        const answers = await Promise.all(verdict.needs.map(async (need) => [factKey(need), await lookupFact(need, ctx.cwd, runLookup)]));
        verdict = judgeCommand(command, { ...options, facts: Object.fromEntries(answers) });
      }
      return verdict.decision === 'block' ? { block: true, reason: `Merge guard: ${verdict.reason}` } : undefined;
    };

    // The enforcement: every tool call, from the model or nested in another
    // tool (`ctx.executeTool`, Fabric's captured tools), passes this hook.
    // A tool activated after `applyKind` is still blocked, and a throw here
    // blocks the call too. The merge guard runs after the profile check.
    pi.on('tool_call', async (event, ctx) => {
      const profile = service.sessionProfile(ctx.sessionManager);
      if (!toolAllowed(profile, event.toolName)) {
        return {
          block: true,
          reason: profile
            ? `This worker runs with the tool profile "${profile.name}", which excludes ${event.toolName}.`
            : `This worker's tool profile cannot be read, so only reading tools run; ${event.toolName} is blocked.`,
        };
      }
      return guardMerges(event, ctx);
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
