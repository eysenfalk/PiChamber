import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWakes } from '../../packages/web/server/lib/pi/session-daemon/orchestration/wakes.js';
import { LAB_ASKER_FOLLOW_UP, LAB_ASKER_QUESTION, LAB_ASKER_TITLE, LAB_CHOOSER_DIALOGS, LAB_CHOOSER_TITLE, fauxOrchestrationExtension, resolveFauxUrl } from './faux-orchestration.mjs';

// The message the daemon sends to a waking orchestrator, built by the real wakes module.
async function wakeText(...events) {
  const document = { workers: { w1: { orchestratorSessionId: 'orch', title: 'Lab: worker', state: 'active' } }, owners: { orch: { cwd: '/lab' } } };
  let content;
  const wakes = createWakes({
    registry: { read: async () => structuredClone(document) },
    getLiveRuntime: () => ({ session: { sendCustomMessage: async (message) => { content = message.content; } } }),
    activateSession: async () => { throw new Error('unexpected activation'); },
    holdSession: () => () => {},
    stateOf: () => 'idle',
    runStartedAt: () => undefined,
    waitingForInput: () => false,
    readSettings: async () => ({ wakes: { coalesceMs: 0 }, watchdog: { enabled: false }, orchestrators: ['orch'] }),
    now: () => Date.now(),
    isGone: () => false,
  });
  for (const [kind, reason] of events) wakes.emit('w1', kind, reason);
  await wakes.tick();
  for (let waited = 0; content === undefined && waited < 1000; waited += 10) await new Promise((done) => setTimeout(done, 10));
  wakes.stop();
  return content;
}

// What the scripted lab model answers to a message, through the provider Pi would call.
async function labExtension(directory) {
  const file = join(directory, 'faux-orchestration.mjs');
  await writeFile(file, fauxOrchestrationExtension({ fauxUrl: resolveFauxUrl(), workerCwd: '/lab/alpha', worktreeWorkerCwd: '/lab/alpha-worktrees/fetch-me' }));
  const registered = { tools: {} };
  (await import(pathToFileURL(file).href)).default({
    registerProvider: (value) => { registered.provider = value; },
    registerTool: (tool) => { registered.tools[tool.name] = tool; },
  });
  return registered;
}

async function labMessage(directory, text, earlier = []) {
  const { provider } = await labExtension(directory);
  return provider.streamSimple(provider.getModels()[0], { messages: [{ role: 'user', content: text, timestamp: Date.now() }, ...earlier] }).result();
}

const labReply = async (directory, text) => (await labMessage(directory, text)).content.map((part) => part.text ?? '').join('');
const toolCallOf = async (directory, text) => (await labMessage(directory, text)).content.find((part) => part.type === 'toolCall');

test('the lab worker reports done when the owner writes GO', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pichamber-faux-'));
  try {
    const file = join(directory, 'faux-orchestration.mjs');
    await writeFile(file, fauxOrchestrationExtension({ fauxUrl: resolveFauxUrl(), workerCwd: '/lab/alpha', worktreeWorkerCwd: '/lab/alpha-worktrees/fetch-me' }));
    let provider;
    (await import(pathToFileURL(file).href)).default({ registerProvider: (value) => { provider = value; }, registerTool: () => {} });
    const message = await provider.streamSimple(provider.getModels()[0], { messages: [{ role: 'user', content: 'GO', timestamp: Date.now() }] }).result();
    expect(message.content.find((part) => part.type === 'toolCall')).toMatchObject({ name: 'mcp__pichamber__worker_report', arguments: { kind: 'done' } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the lab orchestrator answers the wake text the daemon sends', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pichamber-faux-'));
  try {
    expect(await labReply(directory, await wakeText(['run_finished', 'I checked the README. Before I record the result, I need your go: reply GO.'])))
      .toContain('Write GO in its session.');
    expect(await labReply(directory, await wakeText(['done', 'WORKER DONE: the README check passed and is recorded.'])))
      .toContain('Nothing else is open.');
    expect(await labReply(directory, await wakeText(['run_finished', 'a'], ['done', 'WORKER DONE: b'])))
      .toContain('Nothing else is open.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ASK starts the asker, which asks the owner with a brief and asks again after the answer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pichamber-faux-'));
  try {
    expect(await toolCallOf(directory, 'ASK')).toMatchObject({ name: 'mcp__pichamber__session_spawn', arguments: { title: LAB_ASKER_TITLE } });
    const brief = { recommendation: expect.any(String), counterargument: expect.any(String), revisit: expect.any(String) };
    expect(await toolCallOf(directory, 'QUESTION TASK: tighten the README check of this project.')).toMatchObject({
      name: 'mcp__pichamber__worker_report', arguments: { kind: 'question', audience: 'owner', summary: LAB_ASKER_QUESTION, brief },
    });
    expect(await toolCallOf(directory, 'ANSWER: fail it')).toMatchObject({ arguments: { kind: 'question', summary: LAB_ASKER_FOLLOW_UP } });
    // The orchestrator leaves an owner question to the owner.
    expect(await labReply(directory, (await wakeText(['question', LAB_ASKER_QUESTION])).replace('Lab: worker', LAB_ASKER_TITLE)))
      .toContain('I leave that question to you.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CHOOSE starts the chooser, whose tool opens one extension dialog per choice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pichamber-faux-'));
  try {
    expect(await toolCallOf(directory, 'CHOOSE')).toMatchObject({ name: 'mcp__pichamber__session_spawn', arguments: { title: LAB_CHOOSER_TITLE } });
    const task = 'DIALOG TASK: pick the license of this project.';
    expect(await toolCallOf(directory, task)).toMatchObject({ name: 'lab_choose', arguments: LAB_CHOOSER_DIALOGS[0] });
    const answered = (choice) => ({ role: 'toolResult', toolName: 'lab_choose', toolCallId: choice, content: [{ type: 'text', text: choice }], isError: false, timestamp: Date.now() });
    expect((await labMessage(directory, task, [answered('Apache-2.0')])).content.find((part) => part.type === 'toolCall'))
      .toMatchObject({ name: 'lab_choose', arguments: LAB_CHOOSER_DIALOGS[1] });
    expect((await labMessage(directory, task, [answered('Apache-2.0'), answered('Add a badge')])).content.map((part) => part.text ?? '').join(''))
      .toBe('Chosen: Apache-2.0 and Add a badge.');
    // The tool blocks on the session's select dialog and returns the answer.
    const { tools } = await labExtension(directory);
    const asked = [];
    const result = await tools.lab_choose.execute('call', LAB_CHOOSER_DIALOGS[0], undefined, undefined, { ui: { select: async (...args) => { asked.push(args); return 'MIT'; } } });
    expect(asked).toEqual([[LAB_CHOOSER_DIALOGS[0].title, LAB_CHOOSER_DIALOGS[0].options]]);
    expect(result.content[0].text).toBe('MIT');
    // The orchestrator leaves an open dialog to the owner.
    expect(await labReply(directory, (await wakeText(['question', 'dialog: ' + LAB_CHOOSER_DIALOGS[0].title])).replace('Lab: worker', LAB_CHOOSER_TITLE)))
      .toContain('I leave that dialog to you.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
