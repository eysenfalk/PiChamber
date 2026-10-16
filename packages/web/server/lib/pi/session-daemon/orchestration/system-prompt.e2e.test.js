import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionDaemon } from '../session-daemon.js';
import { connectClient, credential, disableHostGate, markOrchestrator, piAiFauxUrl } from './e2e-support.js';
import { ORCHESTRATION_INSTRUCTIONS } from './instructions.js';

// #224: an orchestrator run started by a wake (`sendCustomMessage` with
// `triggerTurn`) must get the same system prompt as a run started by a
// prompt. On Pi 1.1.0 a wake run skipped `before_agent_start`: it lost the
// orchestration instructions and the sections other extensions add there,
// and the transcript recorded those sections as removed, which busted the
// provider's prompt cache at every switch between the two kinds of run.
// The faux model records the system messages of every request it gets.
const extension = (fauxUrl) => `
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(fauxUrl)};

const textOf = (message) => typeof message?.content === 'string'
  ? message.content
  : (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\\n');
const readHello = () => fauxAssistantMessage([fauxToolCall('read', { path: 'hello.txt' })], { stopReason: 'toolUse' });

const respond = (context) => {
  const messages = context.messages ?? [];
  const system = messages.filter((message) => message.role === 'system');
  const firstUser = textOf(messages.find((message) => message.role === 'user'));
  globalThis.__pichamberSystemPrompt.push({
    worker: firstUser.includes('WORKER TASK') && !firstUser.includes('ORCHESTRATE'),
    system: system.map((message) => ({ content: message.content, sections: message.sections })),
  });
  const last = messages.filter((message) => message.role !== 'system').at(-1);
  const text = textOf(last);
  if (last?.role === 'toolResult') return fauxAssistantMessage(text.includes('hello') ? 'READ DONE' : 'PARENT SPAWNED');
  if (text.includes('ORCHESTRATE')) {
    return fauxAssistantMessage([fauxToolCall('mcp__pichamber__session_spawn', {
      cwd: process.cwd(),
      task: 'WORKER TASK',
      model: { providerId: 'faux', modelId: 'faux-1' },
      clientRequestId: 'spawn-1',
    })], { stopReason: 'toolUse' });
  }
  if (text.includes('WORKER DONE') || text.includes('AGAIN')) return readHello();
  return fauxAssistantMessage(text.includes('WORKER TASK') ? 'WORKER DONE' : 'UNSCRIPTED');
};

export default function (pi) {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 50 }, () => respond));
  pi.registerProvider(faux.provider);
  // Stands in for extensions such as aft and sandy that add a section per run.
  pi.on('before_agent_start', (event) => {
    event.systemPromptOptions.sections.probe_section = 'PROBE SECTION';
  });
}
`;

// The system prompt a request carries: the sections in effect after the
// transcript's patches, and the full prompt texts.
const promptOf = (system) => {
  const sections = {};
  for (const message of system) {
    for (const [key, value] of Object.entries(message.sections ?? {})) {
      if (value === null) delete sections[key];
      else sections[key] = value;
    }
  }
  return JSON.stringify({ sections, content: system.map((message) => message.content ?? '') });
};

const sessionFiles = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => join(entry.parentPath, entry.name));
};

describe('orchestrator system prompt through the real SDK', () => {
  let root;
  let daemon;
  let client;
  const previousDataDir = process.env.PICHAMBER_DATA_DIR;

  afterEach(async () => {
    await client?.close().catch(() => {});
    await daemon?.stop();
    client = undefined;
    daemon = undefined;
    delete globalThis.__pichamberSystemPrompt;
    if (previousDataDir === undefined) delete process.env.PICHAMBER_DATA_DIR;
    else process.env.PICHAMBER_DATA_DIR = previousDataDir;
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('sends the same system prompt with the instructions to prompt and wake runs, and none to the worker (#224)', async () => {
    const requests = globalThis.__pichamberSystemPrompt = [];
    root = await mkdtemp(join(tmpdir(), 'pichamber-system-prompt-e2e-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(join(projectDir, 'hello.txt'), 'hello');
    await writeFile(join(agentDir, 'extensions', 'faux-system-prompt.ts'), extension(piAiFauxUrl()));
    process.env.PICHAMBER_DATA_DIR = join(root, 'data');
    disableHostGate(process.env.PICHAMBER_DATA_DIR, { wakes: { coalesceMs: 0 } });
    const endpoint = join(root, 'daemon.sock');
    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();
    client = connectClient(endpoint);
    await client.authenticate();

    const created = await client.request('sessions.create', { cwd: projectDir, model: { providerId: 'faux', modelId: 'faux-1' } });
    const parentId = created.result.session.id;
    markOrchestrator(process.env.PICHAMBER_DATA_DIR, parentId);
    const replies = (text) => client.events.filter((message) => message.event === 'assistant.message.end'
      && message.payload?.sessionId === parentId && message.payload?.text === text).length;
    const reply = (text, count) => client.next(() => replies(text) >= count, 60_000);

    // Run 1, prompt: the orchestrator spawns a worker.
    await client.request('sessions.prompt', { sessionId: parentId, text: 'ORCHESTRATE one worker' });
    await reply('PARENT SPAWNED', 1);
    // Run 2, wake: the worker's run end wakes the orchestrator, which reads a file.
    await reply('READ DONE', 1);
    // Run 3, prompt: the owner asks again, and it reads the file again.
    await client.request('sessions.prompt', { sessionId: parentId, text: 'AGAIN read the file' });
    await reply('READ DONE', 2);

    const parent = requests.filter((request) => !request.worker);
    const worker = requests.filter((request) => request.worker);
    // Two requests per run: the tool call and the reply after its result.
    expect(parent).toHaveLength(6);
    expect(worker.length).toBeGreaterThanOrEqual(1);
    expect(new Set(parent.map((request) => promptOf(request.system))).size).toBe(1);
    expect(parent.every((request) => promptOf(request.system).includes(JSON.stringify(ORCHESTRATION_INSTRUCTIONS).slice(1, -1)))).toBe(true);
    expect(worker.some((request) => promptOf(request.system).includes(JSON.stringify(ORCHESTRATION_INSTRUCTIONS).slice(1, -1)))).toBe(false);
    expect(worker.every((request) => promptOf(request.system).includes('PROBE SECTION'))).toBe(true);

    // No transcript records the section as removed.
    const files = await sessionFiles(agentDir);
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const file of files) expect(await readFile(file, 'utf8')).not.toContain('"probe_section":null');
  }, 120_000);
});
