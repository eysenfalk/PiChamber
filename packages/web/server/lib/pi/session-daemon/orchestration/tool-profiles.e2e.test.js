import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionDaemon } from '../session-daemon.js';
import { connectClient, credential, disableHostGate, markOrchestrator, piAiFauxUrl } from './e2e-support.js';

// Worker tool profiles (#151) through the real daemon and Pi SDK. A scripted
// faux model starts a `review` worker (default `read-only`) that tries to
// write a file directly, through a nested `ctx.executeTool` call, and after an
// extension activated `write` again; the run is repeated after a daemon
// restart. The script logs the tool list of every request and each result.

const fauxExtension = (fauxUrl, { workerDir, target }) => `
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from ${JSON.stringify(fauxUrl)};

const textOf = (message) => typeof message?.content === 'string'
  ? message.content
  : (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\\n');
const TARGET = ${JSON.stringify(target)};
const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });

const respond = async (context) => {
  const log = globalThis.__pichamberProfileLog ??= [];
  const messages = context.messages ?? [];
  // The request carries the tool set as additions and removals on its system messages.
  const active = new Set();
  for (const message of messages.filter((entry) => entry.role === 'system')) {
    for (const tool of message.toolsRemoved ?? []) active.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) active.add(tool.name);
  }
  const tools = [...active];
  const userIndex = messages.findLastIndex((message) => message.role === 'user');
  const task = textOf(messages[userIndex]);
  const results = messages.slice(userIndex + 1).filter((message) => message.role === 'toolResult');
  const last = results.at(-1);
  log.push({ task, tools, result: last ? { toolName: last.toolName, isError: last.isError, text: textOf(last) } : undefined });
  if (task.startsWith('A worker event')) return fauxAssistantMessage('PARENT WOKEN');
  if (task.includes('ORCHESTRATE')) {
    if (last) return fauxAssistantMessage('PARENT SPAWNED');
    return call('mcp__pichamber__session_spawn', {
      cwd: ${JSON.stringify(workerDir)},
      task: 'WORKER TASK',
      title: 'Read-only worker',
      role: 'review',
      model: { providerId: 'faux', modelId: 'faux-1' },
      excludeExtensions: ['*/notes-tool.ts'],
      clientRequestId: 'spawn-review',
    });
  }
  if (task.includes('WORKER TASK')) {
    const steps = [
      () => call('write', { path: TARGET, content: 'CHANGED BY WRITE' }),
      () => call('activate_write', {}),
      () => call('write', { path: TARGET, content: 'CHANGED AFTER ACTIVATION' }),
      () => call('nested_write', {}),
      () => call('read', { path: TARGET }),
    ];
    return steps[results.length]?.() ?? fauxAssistantMessage('WORKER DONE');
  }
  if (task.includes('AFTER RESTART')) {
    return results.length === 0 ? call('write', { path: TARGET, content: 'CHANGED AFTER RESTART' }) : fauxAssistantMessage('RESTART DONE');
  }
  return fauxAssistantMessage(fauxText('UNSCRIPTED'));
};

export default function (pi) {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 50 }, () => respond));
  pi.registerProvider(faux.provider);
  // A tool that runs another tool, like Fabric's captured tools.
  pi.registerTool({
    name: 'nested_write',
    label: 'Nested write',
    description: 'Writes the target through ctx.executeTool.',
    parameters: { type: 'object', properties: {} },
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const outcome = await ctx.executeTool('write', { path: TARGET, content: 'CHANGED BY NESTED WRITE' });
      return { content: [{ type: 'text', text: 'NESTED ' + JSON.stringify({ isError: outcome.isError, text: textOf(outcome.result ?? outcome) }) }], details: {} };
    },
  });
  // An extension that turns write on again after the profile removed it.
  pi.registerTool({
    name: 'activate_write',
    label: 'Activate write',
    description: 'Adds write to the active tools.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      pi.setActiveTools([...pi.getActiveTools(), 'write']);
      return { content: [{ type: 'text', text: 'ACTIVATED ' + pi.getActiveTools().includes('write') }], details: {} };
    },
  });
}
`;

const notesExtension = `
export default function (pi) {
  pi.registerTool({
    name: 'note_tool',
    label: 'Note',
    description: 'A tool of an extension the worker profile excludes.',
    parameters: { type: 'object', properties: {} },
    async execute() { return { content: [{ type: 'text', text: 'noted' }], details: {} }; },
  });
}
`;

describe('worker tool profiles through the real daemon', () => {
  let daemon;
  const previousDataDir = process.env.PICHAMBER_DATA_DIR;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    if (previousDataDir === undefined) delete process.env.PICHAMBER_DATA_DIR;
    else process.env.PICHAMBER_DATA_DIR = previousDataDir;
    delete globalThis.__pichamberProfileLog;
  });

  it('blocks the excluded tools of a read-only worker, drops its excluded extension, and keeps both after a restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-tool-profiles-e2e-'));
    const projectDir = join(root, 'project');
    const workerDir = join(root, 'worker');
    const agentDir = join(root, 'agent');
    const target = join(workerDir, 'target.txt');
    await mkdir(projectDir, { recursive: true });
    await mkdir(workerDir, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(target, 'ORIGINAL');
    await writeFile(join(agentDir, 'extensions', 'faux-profiles.ts'), fauxExtension(piAiFauxUrl(), { workerDir, target }));
    await writeFile(join(agentDir, 'extensions', 'notes-tool.ts'), notesExtension);
    process.env.PICHAMBER_DATA_DIR = join(root, 'data');
    // Wakes without delay, so the orchestrator's wake turn runs and ends
    // before the restart instead of racing the daemon stop.
    disableHostGate(process.env.PICHAMBER_DATA_DIR, { wakes: { coalesceMs: 0 } });
    const endpoint = join(root, 'daemon.sock');
    const start = async () => {
      daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
      await daemon.start();
      const client = connectClient(endpoint);
      await client.authenticate();
      return client;
    };
    // A missing answer fails with what the model saw, not only a timeout.
    const answer = (client, text) => client.next((message) => message.event === 'assistant.message.end'
      && message.payload?.text === text, 60_000).catch((error) => {
      const seen = (globalThis.__pichamberProfileLog ?? []).map(({ task, result }) => ({ task: task.slice(0, 80), result }));
      const ends = client.events.filter((message) => message.event === 'assistant.message.end').map((message) => message.payload?.text);
      throw new Error(`${error.message} (${text}); model requests: ${JSON.stringify(seen)}; answers: ${JSON.stringify(ends)}`);
    });

    let client = await start();
    const created = await client.request('sessions.create', { cwd: projectDir, model: { providerId: 'faux', modelId: 'faux-1' } });
    const parentId = created.result.session.id;
    markOrchestrator(process.env.PICHAMBER_DATA_DIR, parentId);
    const workerDone = answer(client, 'WORKER DONE');
    const parentWoken = answer(client, 'PARENT WOKEN');
    await client.request('sessions.prompt', { sessionId: parentId, text: 'ORCHESTRATE a review' });
    const workerId = (await workerDone).payload.sessionId;
    expect((await parentWoken).payload.sessionId).toBe(parentId);

    const log = globalThis.__pichamberProfileLog;
    const parentTools = log.find((entry) => entry.task.includes('ORCHESTRATE')).tools;
    const worker = log.filter((entry) => entry.task.endsWith('WORKER TASK'));
    const workerTools = worker[0].tools;
    // The orchestrator runs full; the worker's request lacks the excluded
    // tools and the tool of its excluded extension, and keeps bash and reading.
    expect(parentTools).toEqual(expect.arrayContaining(['write', 'edit', 'note_tool', 'nested_write']));
    expect(workerTools).toEqual(expect.arrayContaining(['read', 'bash', 'nested_write', 'mcp__pichamber__worker_report']));
    expect(workerTools).not.toContain('write');
    expect(workerTools).not.toContain('edit');
    expect(workerTools).not.toContain('note_tool');

    const [direct, activated, afterActivation, nested, read] = worker.slice(1).map((entry) => entry.result);
    expect(direct).toMatchObject({ toolName: 'write', isError: true });
    // Not active, so the SDK does not find it; the call check is the second line.
    expect(direct.text).toBe('Tool write not found');
    expect(activated.text).toBe('ACTIVATED true');
    // Activated again, sent to the model again, still blocked by the call check.
    expect(worker[3].tools).toContain('write');
    expect(afterActivation).toMatchObject({ toolName: 'write', isError: true });
    expect(afterActivation.text).toContain('tool profile "read-only"');
    // A tool that runs write through ctx.executeTool gets the same block.
    expect(JSON.parse(nested.text.slice('NESTED '.length))).toEqual({ isError: true, text: 'This worker runs with the tool profile "read-only", which excludes write.' });
    expect(read).toMatchObject({ toolName: 'read', isError: false, text: 'ORIGINAL' });
    expect(await readFile(target, 'utf8')).toBe('ORIGINAL');

    // The orchestrator and the session itself report the recorded profile.
    const listed = await client.request('orchestration.call', { sessionId: parentId, tool: 'session_list', args: {} });
    expect(listed.result.value.sessions[0]).toMatchObject({
      sessionId: workerId,
      profile: { name: 'read-only', excludeExtensions: ['*/notes-tool.ts'] },
    });

    // After a restart the reopened worker gets its exclusions from its lineage.
    await client.close();
    await daemon.stop();
    globalThis.__pichamberProfileLog = [];
    client = await start();
    const restartDone = answer(client, 'RESTART DONE');
    // Pi restores a session's model only when its provider already counts as
    // configured; the keyless faux provider counts only after an async
    // availability check, so the prompt names its model instead of racing it.
    await client.request('sessions.prompt', { sessionId: workerId, text: 'AFTER RESTART', model: { providerId: 'faux', modelId: 'faux-1' } });
    await restartDone;
    const [before, after] = globalThis.__pichamberProfileLog.filter((entry) => entry.task === 'AFTER RESTART');
    expect(before.tools).toContain('read');
    expect(before.tools).not.toContain('write');
    expect(before.tools).not.toContain('note_tool');
    expect(after.result).toMatchObject({ toolName: 'write', isError: true });
    expect(await readFile(target, 'utf8')).toBe('ORIGINAL');
    await client.close();
  }, 180_000);
});
