import { createConnection } from 'node:net';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionDaemon } from '../session-daemon.js';
import { ORCHESTRATION_TOOLS, qualifiedToolName } from './tool-contracts.js';

// Orchestration through the real Pi SDK: the daemon's inline extension gives
// a session the mcp__pichamber__* tools, a scripted faux model calls
// session_spawn, and the worker's result comes back as a parent turn. Pi's
// faux provider stands in for a model; its script reacts to the transcript.
const credential = 'a-private-daemon-credential';

// pi-ai is a dependency of the pinned SDK, not of PiChamber; locate it next
// to (or inside) the SDK package the daemon actually loads.
const piAiFauxUrl = () => {
  const sdkDir = realpathSync(fileURLToPath(new URL('../../../../../node_modules/@earendil-works/pi-coding-agent', import.meta.url)));
  const candidates = [join(dirname(sdkDir), 'pi-ai'), join(sdkDir, 'node_modules', '@earendil-works', 'pi-ai')];
  const piAiDir = candidates.find((candidate) => existsSync(join(candidate, 'dist', 'providers', 'faux.js')));
  if (!piAiDir) throw new Error('Pi faux provider not found next to the SDK.');
  return pathToFileURL(join(piAiDir, 'dist', 'providers', 'faux.js')).href;
};

const fauxExtension = (fauxUrl, workerDir) => `
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from ${JSON.stringify(fauxUrl)};

const textOf = (message) => typeof message?.content === 'string'
  ? message.content
  : (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\\n');

const respond = (context) => {
  const log = globalThis.__pichamberOrchestrationLog ??= [];
  const messages = context.messages ?? [];
  const system = messages.filter((message) => message.role === 'system');
  const systemText = JSON.stringify(system);
  const tools = [...systemText.matchAll(/"name":"([A-Za-z0-9_]+)"/g)].map((match) => match[1]);
  const last = messages.filter((message) => message.role !== 'system').at(-1);
  log.push({ tools, lastRole: last?.role, lastText: textOf(last), hasInstructions: systemText.includes('PiChamber orchestration') });
  if (last?.role === 'toolResult') return fauxAssistantMessage('PARENT SPAWNED');
  const lastText = textOf(last);
  if (lastText.includes('WORKER TASK')) return fauxAssistantMessage('WORKER DONE with ' + tools.filter((name) => name.startsWith('mcp__pichamber__')).join(','));
  if (lastText.includes('ORCHESTRATE')) {
    return fauxAssistantMessage([fauxToolCall('mcp__pichamber__session_spawn', {
      cwd: ${JSON.stringify(workerDir)},
      task: 'WORKER TASK: report your tools',
      title: 'Faux worker',
      model: { providerId: 'faux', modelId: 'faux-1' },
      clientRequestId: 'spawn-1',
    })], { stopReason: 'toolUse' });
  }
  if (lastText.includes('WORKER DONE')) return fauxAssistantMessage('PARENT GOT RESULT');
  return fauxAssistantMessage(fauxText('UNSCRIPTED'));
};

export default function (pi) {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 50 }, () => respond));
  pi.registerProvider(faux.provider);
}
`;

function connectClient(endpoint) {
  const socket = createConnection({ path: endpoint });
  let buffer = '';
  const messages = [];
  const waiters = [];
  const publish = (message) => {
    messages.push(message);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (waiters[index].predicate(message)) waiters.splice(index, 1)[0].resolve(message);
    }
  };
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line) publish(JSON.parse(line));
    }
  });
  const next = (predicate, timeoutMs = 30_000) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for daemon message')), timeoutMs);
      waiters.push({ predicate, resolve: (message) => { clearTimeout(timer); resolve(message); } });
    });
  };
  return {
    async authenticate() {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(`${JSON.stringify({ kind: 'authenticate', credential })}\n`);
      await next((message) => message.kind === 'authenticated');
    },
    request(command, payload = {}) {
      const requestId = `request-${Math.random()}`;
      socket.write(`${JSON.stringify({ protocolVersion: 1, kind: 'request', requestId, command, payload })}\n`);
      return next((message) => (message.kind === 'response' && message.requestId === requestId) || message.kind === 'error');
    },
    next,
    events: messages,
    async close() {
      socket.end();
      await new Promise((resolve) => socket.once('close', resolve));
    },
  };
}

describe('orchestration end-to-end through the real SDK', () => {
  let daemon;
  const previousDataDir = process.env.PICHAMBER_DATA_DIR;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    if (previousDataDir === undefined) delete process.env.PICHAMBER_DATA_DIR;
    else process.env.PICHAMBER_DATA_DIR = previousDataDir;
    delete globalThis.__pichamberOrchestrationLog;
  });

  it('spawns a worker without spawn rights and delivers its result as a parent turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-orchestration-e2e-'));
    const projectDir = join(root, 'project');
    const workerDir = join(root, 'worker');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(workerDir, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(join(agentDir, 'extensions', 'faux-orchestration.ts'), fauxExtension(piAiFauxUrl(), workerDir));
    process.env.PICHAMBER_DATA_DIR = join(root, 'data');

    const endpoint = join(root, 'daemon.sock');
    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();

    const created = await client.request('sessions.create', { cwd: projectDir, model: { providerId: 'faux', modelId: 'faux-1' } });
    expect(created.kind).toBe('response');
    const parentId = created.result.session.id;

    const delivered = client.next((message) => message.event === 'extension.message'
      && message.payload?.sessionId === parentId
      && message.payload?.customType === 'pichamber.orchestration.result', 30_000);
    const parentAnswered = client.next((message) => message.event === 'assistant.message.end'
      && message.payload?.sessionId === parentId
      && message.payload?.text === 'PARENT GOT RESULT', 30_000);
    await client.request('sessions.prompt', { sessionId: parentId, text: 'ORCHESTRATE one worker' });

    const result = await delivered;
    expect(result.payload.text).toContain('WORKER DONE with');
    await parentAnswered;

    const log = globalThis.__pichamberOrchestrationLog ?? [];
    const parentTurn = log.find((entry) => entry.lastText.includes('ORCHESTRATE'));
    const workerTurn = log.find((entry) => entry.lastText.includes('WORKER TASK'));
    const all = ORCHESTRATION_TOOLS.map((tool) => qualifiedToolName(tool.name));
    const workerAllowed = ORCHESTRATION_TOOLS.filter((tool) => tool.childAllowed !== false).map((tool) => qualifiedToolName(tool.name));

    // The orchestrator sees all eight tools and the base instructions in its
    // system prompt; the worker never sees spawn or stop, nor the instructions.
    expect(parentTurn.tools).toEqual(expect.arrayContaining(all));
    expect(parentTurn.hasInstructions).toBe(true);
    expect(parentTurn.lastText).toBe('ORCHESTRATE one worker');
    expect(workerTurn.tools).toEqual(expect.arrayContaining(workerAllowed));
    expect(workerTurn.tools).not.toContain(qualifiedToolName('session_spawn'));
    expect(workerTurn.tools).not.toContain(qualifiedToolName('session_stop'));
    expect(workerTurn.hasInstructions).toBe(false);

    // The worker is an ordinary session the owner can open, linked to its parent.
    const workerId = result.payload.details?.sessionId;
    expect(workerId).toBeTruthy();
    const workerOpened = await client.request('sessions.open', { sessionId: workerId });
    expect(workerOpened.kind).toBe('response');
    expect(workerOpened.result.session.directory).toBe(workerDir);

    // The IPC path the MCP route uses acts as the given session and sees the
    // live catalog, role defaults, the limit and the host.
    const capabilities = await client.request('orchestration.call', { sessionId: parentId, tool: 'orchestration_capabilities', args: {} });
    expect(capabilities.result.value).toMatchObject({ workerLimit: 4, canSpawn: true });
    expect(capabilities.result.value.models).toContainEqual(expect.objectContaining({ providerId: 'faux', modelId: 'faux-1' }));
    expect(capabilities.result.value.roles.review).toMatchObject({ modelId: 'gpt-6.1-sol', thinking: 'high' });
    expect(capabilities.result.value.host).toEqual(expect.objectContaining({ cpuCount: expect.any(Number), memory: expect.objectContaining({ freeBytes: expect.any(Number) }) }));
    const workerSpawn = await client.request('orchestration.call', { sessionId: workerId, tool: 'session_spawn', args: { cwd: workerDir, task: 'nested' } });
    expect(workerSpawn.result.error).toMatchObject({ code: expect.stringMatching(/^ORCHESTRATION_/) });

    await client.close();
  }, 120_000);
});
