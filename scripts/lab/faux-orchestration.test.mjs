import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWakes } from '../../packages/web/server/lib/pi/session-daemon/orchestration/wakes.js';
import { fauxOrchestrationExtension, resolveFauxUrl } from './faux-orchestration.mjs';

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
async function labReply(directory, text) {
  const file = join(directory, 'faux-orchestration.mjs');
  await writeFile(file, fauxOrchestrationExtension({ fauxUrl: resolveFauxUrl(), workerCwd: '/lab/alpha', worktreeWorkerCwd: '/lab/alpha-worktrees/fetch-me' }));
  let provider;
  (await import(pathToFileURL(file).href)).default({ registerProvider: (value) => { provider = value; } });
  const message = await provider.streamSimple(provider.getModels()[0], { messages: [{ role: 'user', content: text, timestamp: Date.now() }] }).result();
  return message.content.map((part) => part.text ?? '').join('');
}

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
