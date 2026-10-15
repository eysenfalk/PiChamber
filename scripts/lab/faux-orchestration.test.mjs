import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { schemaViolation } from '../../packages/web/server/lib/pi/session-daemon/orchestration/contract-validator.js';
import { reportViolation } from '../../packages/web/server/lib/pi/session-daemon/orchestration/report-rules.js';
import { ORCHESTRATION_TOOLS } from '../../packages/web/server/lib/pi/session-daemon/orchestration/tool-contracts.js';
import { createWakes } from '../../packages/web/server/lib/pi/session-daemon/orchestration/wakes.js';
import { LAB_ASKER_BLOCKER, LAB_ASKER_OPTIONS, LAB_ASKER_QUESTION, LAB_ASKER_TITLE, fauxOrchestrationExtension, resolveFauxUrl } from './faux-orchestration.mjs';

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
async function labMessage(directory, text) {
  const file = join(directory, 'faux-orchestration.mjs');
  await writeFile(file, fauxOrchestrationExtension({ fauxUrl: resolveFauxUrl(), workerCwd: '/lab/alpha', worktreeWorkerCwd: '/lab/alpha-worktrees/fetch-me' }));
  let provider;
  (await import(pathToFileURL(file).href)).default({ registerProvider: (value) => { provider = value; } });
  return provider.streamSimple(provider.getModels()[0], { messages: [{ role: 'user', content: text, timestamp: Date.now() }] }).result();
}

const labReply = async (directory, text) => (await labMessage(directory, text)).content.map((part) => part.text ?? '').join('');
const toolCallOf = async (directory, text) => (await labMessage(directory, text)).content.find((part) => part.type === 'toolCall');

test('the lab worker reports done when the owner writes GO', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pichamber-faux-'));
  try {
    const file = join(directory, 'faux-orchestration.mjs');
    await writeFile(file, fauxOrchestrationExtension({ fauxUrl: resolveFauxUrl(), workerCwd: '/lab/alpha', worktreeWorkerCwd: '/lab/alpha-worktrees/fetch-me' }));
    let provider;
    (await import(pathToFileURL(file).href)).default({ registerProvider: (value) => { provider = value; } });
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

test('ASK starts the asker, which asks the owner with a brief and reports a blocker after an option answer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pichamber-faux-'));
  try {
    expect(await toolCallOf(directory, 'ASK')).toMatchObject({ name: 'mcp__pichamber__session_spawn', arguments: { title: LAB_ASKER_TITLE } });
    // Both questions pass the daemon's contract and owner rules, so the lab shows them.
    const workerReport = ORCHESTRATION_TOOLS.find((tool) => tool.name === 'worker_report');
    const accepted = (call) => [schemaViolation(workerReport.parameters, call.arguments), reportViolation(call.arguments)];
    const question = await toolCallOf(directory, 'QUESTION TASK: tighten the README check of this project.');
    expect(question).toMatchObject({ name: 'mcp__pichamber__worker_report', arguments: { kind: 'question', audience: 'owner', summary: LAB_ASKER_QUESTION } });
    expect(accepted(question)).toEqual([null, null]);
    expect(question.arguments.brief.options).toHaveLength(3);
    // An option button answers with the label, with or without a note.
    for (const answer of [LAB_ASKER_OPTIONS[0].label, `${LAB_ASKER_OPTIONS[1].label}\n\nonly for this release`]) {
      const blocker = await toolCallOf(directory, answer);
      expect(blocker).toMatchObject({ name: 'mcp__pichamber__worker_report', arguments: { kind: 'blocked', audience: 'owner', summary: LAB_ASKER_BLOCKER } });
      expect(accepted(blocker)).toEqual([null, null]);
    }
    // A free text answer to the blocker only lets the worker go on.
    expect(await labReply(directory, 'ANSWER: keep the copy')).toBe('Got your answer (ANSWER: keep the copy). I go on with the license check.');
    expect(await toolCallOf(directory, 'Fail the check later')).toBeUndefined();
    // The orchestrator leaves an owner question to the owner.
    expect(await labReply(directory, (await wakeText(['question', LAB_ASKER_QUESTION])).replace('Lab: worker', LAB_ASKER_TITLE)))
      .toContain('I leave that question to you.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
