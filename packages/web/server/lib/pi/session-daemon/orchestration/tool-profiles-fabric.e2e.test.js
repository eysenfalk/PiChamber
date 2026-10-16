import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionDaemon } from '../session-daemon.js';
import { connectClient, credential, disableHostGate, markOrchestrator, piAiFauxUrl } from './e2e-support.js';

// Worker tool profiles (#151) for calls through pi-fabric (#226). Fabric's
// `fabric_exec` runs a program that calls Pi tools as `pi.*` and extension
// tools as `extensions.*`; both reach Pi's tool execution, where the profile
// check sits. A `review` worker (`read-only`) runs a program that writes a
// file, calls an extension tool matched by `*subagent*` and reads the file;
// the orchestrator first calls the same extension tool, which runs.
// Fabric's `mcp.*` calls go to MCP servers directly and are not covered here.
// Opt in with PICHAMBER_TEST_PI_FABRIC set to an installed pi-fabric package
// directory; the test loads it as the only Pi package.
const FABRIC = process.env.PICHAMBER_TEST_PI_FABRIC;

const fauxExtension = (fauxUrl, { workerDir, target }) => `
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from ${JSON.stringify(fauxUrl)};

const textOf = (message) => typeof message?.content === 'string'
  ? message.content
  : (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\\n');
const TARGET = ${JSON.stringify(target)};
const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
// Each call's outcome as one short word, since Fabric prints the result as YAML.
const attempt = 'const out = {};\\n'
  + 'const attempt = async (key, run) => {\\n'
  + '  try { const text = JSON.stringify(await run()); out[key] = text.includes("ORIGINAL") ? "read-original" : text.includes("PROBE SUBAGENT RAN") ? "ran-extension" : "ran"; }\\n'
  + '  catch (error) { const message = String(error?.message ?? error); out[key] = /tool profile .read-only., which excludes/.test(message) ? "blocked-by-profile" : "failed: " + message.slice(0, 120); }\\n'
  + '};\\n';
const CONTROL = attempt + 'await attempt("extension", () => (extensions as any).probe_subagent({}));\\nreturn out;';
const WORKER = attempt + [
  'await attempt("write", () => pi.write({ path: ' + JSON.stringify(TARGET) + ', text: "CHANGED BY FABRIC" }));',
  'await attempt("extension", () => (extensions as any).probe_subagent({}));',
  'await attempt("read", () => pi.read(' + JSON.stringify(TARGET) + '));',
  'return out;',
].join('\\n');

const respond = async (context) => {
  const log = globalThis.__pichamberFabricLog ??= [];
  const messages = context.messages ?? [];
  const userIndex = messages.findLastIndex((message) => message.role === 'user');
  const task = textOf(messages[userIndex]);
  const results = messages.slice(userIndex + 1).filter((message) => message.role === 'toolResult');
  const last = results.at(-1);
  log.push({ task, result: last ? { toolName: last.toolName, isError: last.isError, text: textOf(last) } : undefined });
  if (task.startsWith('A worker event')) return fauxAssistantMessage('PARENT WOKEN');
  if (task.includes('ORCHESTRATE')) {
    if (results.length === 0) return call('fabric_exec', { code: CONTROL });
    if (results.length === 1) {
      return call('mcp__pichamber__session_spawn', {
        cwd: ${JSON.stringify(workerDir)},
        task: 'WORKER TASK',
        title: 'Read-only fabric worker',
        role: 'review',
        model: { providerId: 'faux', modelId: 'faux-1' },
        clientRequestId: 'spawn-fabric-review',
      });
    }
    return fauxAssistantMessage('PARENT SPAWNED');
  }
  if (task.includes('WORKER TASK')) {
    return results.length === 0 ? call('fabric_exec', { code: WORKER }) : fauxAssistantMessage('WORKER DONE');
  }
  return fauxAssistantMessage(fauxText('UNSCRIPTED'));
};

export default function (pi) {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 50 }, () => respond));
  pi.registerProvider(faux.provider);
  pi.registerTool({
    name: 'probe_subagent',
    label: 'Probe subagent',
    description: 'An extension tool the read-only profile excludes by *subagent*.',
    parameters: { type: 'object', properties: {} },
    async execute() { return { content: [{ type: 'text', text: 'PROBE SUBAGENT RAN' }], details: {} }; },
  });
}
`;

// The `key: value` lines of a program's object result in Fabric's output.
const programResult = (text) => Object.fromEntries([...text.matchAll(/^(\w+): (.*)$/gm)].map(([, key, value]) => [key, value]));

describe.skipIf(!FABRIC)('worker tool profiles through pi-fabric', () => {
  let daemon;
  const previous = { dataDir: process.env.PICHAMBER_DATA_DIR, agentDir: process.env.PI_CODING_AGENT_DIR };

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    for (const [key, value] of [['PICHAMBER_DATA_DIR', previous.dataDir], ['PI_CODING_AGENT_DIR', previous.agentDir]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete globalThis.__pichamberFabricLog;
  });

  it('blocks excluded pi.* and extensions.* calls of a read-only worker and keeps reading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-tool-profiles-fabric-e2e-'));
    const projectDir = join(root, 'project');
    const workerDir = join(root, 'worker');
    const agentDir = join(root, 'agent');
    const target = join(workerDir, 'target.txt');
    await mkdir(projectDir, { recursive: true });
    await mkdir(workerDir, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(target, 'ORIGINAL');
    await writeFile(join(agentDir, 'extensions', 'faux-fabric.ts'), fauxExtension(piAiFauxUrl(), { workerDir, target }));
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [FABRIC] }));
    // Full code mode routes every tool through fabric_exec; approvals allow
    // without a UI, so only the tool profile can refuse a call.
    await writeFile(join(agentDir, 'fabric.json'), JSON.stringify({
      fullCodeMode: true,
      approvals: { read: 'allow', write: 'allow', execute: 'allow', network: 'allow', agent: 'allow' },
      mcp: { enabled: false },
    }));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PICHAMBER_DATA_DIR = join(root, 'data');
    disableHostGate(process.env.PICHAMBER_DATA_DIR, { wakes: { coalesceMs: 0 } });
    daemon = createSessionDaemon({ endpoint: join(root, 'daemon.sock'), credential, cwd: projectDir, agentDir });
    await daemon.start();
    const client = connectClient(join(root, 'daemon.sock'));
    await client.authenticate();
    const answer = (text) => client.next((message) => message.event === 'assistant.message.end'
      && message.payload?.text === text, 120_000).catch((error) => {
      const seen = (globalThis.__pichamberFabricLog ?? []).map(({ task, result }) => ({ task: task.slice(0, 80), result }));
      throw new Error(`${error.message} (${text}); model requests: ${JSON.stringify(seen)}`);
    });

    const created = await client.request('sessions.create', { cwd: projectDir, model: { providerId: 'faux', modelId: 'faux-1' } });
    const parentId = created.result.session.id;
    markOrchestrator(process.env.PICHAMBER_DATA_DIR, parentId);
    const workerDone = answer('WORKER DONE');
    const parentWoken = answer('PARENT WOKEN');
    await client.request('sessions.prompt', { sessionId: parentId, text: 'ORCHESTRATE a fabric review' });
    await workerDone;
    await parentWoken;

    const log = globalThis.__pichamberFabricLog;
    const control = log.filter((entry) => entry.task.includes('ORCHESTRATE'))[1].result;
    expect(control).toMatchObject({ toolName: 'fabric_exec' });
    expect(programResult(control.text)).toEqual({ extension: 'ran-extension' });

    const worker = log.filter((entry) => entry.task.endsWith('WORKER TASK'))[1].result;
    expect(worker).toMatchObject({ toolName: 'fabric_exec' });
    expect(programResult(worker.text)).toEqual({ write: 'blocked-by-profile', extension: 'blocked-by-profile', read: 'read-original' });
    expect(await readFile(target, 'utf8')).toBe('ORIGINAL');
    await client.close();
  }, 200_000);
});
