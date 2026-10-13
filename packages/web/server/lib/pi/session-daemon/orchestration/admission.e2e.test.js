import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionDaemon } from '../session-daemon.js';
import { connectClient, credential, disableHostGate, piAiFauxUrl } from './e2e-support.js';
import { createOrchestrationRegistryStore } from './registry-store.js';

// A worker's slot through Pi SDK 1.1.0's own awaits in prompt(): input
// handlers run before Pi decides between a new run and a queued follow-up
// (W1), and a prompt made while `agent_settled` handlers run is deferred and
// resolves before its run starts (W2). The faux model and the extension's
// gates hold Pi at exactly those points.
const extension = (fauxUrl, workerDir) => `
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(fauxUrl)};

const textOf = (message) => typeof message?.content === 'string'
  ? message.content
  : (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\\n');
const gates = () => globalThis.__pichamberAdmission ?? {};

const respond = async (context) => {
  const last = (context.messages ?? []).filter((message) => message.role !== 'system').at(-1);
  if (last?.role === 'toolResult') return fauxAssistantMessage('PARENT SPAWNED');
  const text = textOf(last);
  if (text.startsWith('RUN ')) {
    gates().running?.(text);
    await gates().response?.promise;
    return fauxAssistantMessage('RAN ' + text);
  }
  if (text.includes('ORCHESTRATE')) {
    return fauxAssistantMessage([fauxToolCall('mcp__pichamber__session_spawn', {
      cwd: ${JSON.stringify(workerDir)},
      task: 'WORKER TASK',
      model: { providerId: 'faux', modelId: 'faux-1' },
      clientRequestId: 'spawn-1',
    })], { stopReason: 'toolUse' });
  }
  if (text.includes('WORKER DONE')) return fauxAssistantMessage('PARENT GOT RESULT');
  return fauxAssistantMessage(text.includes('WORKER TASK') ? 'WORKER DONE' : 'UNSCRIPTED');
};

export default function (pi) {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 50 }, () => respond));
  pi.registerProvider(faux.provider);
  pi.on('input', async (event) => {
    const gate = gates().input;
    if (gate && event.text.startsWith('RUN ')) { gate.entered(event.text); await gate.promise; }
    return { action: 'continue' };
  });
  // One-shot: the first settle after the gate is set waits for it.
  pi.on('agent_settled', async () => {
    const gate = gates().settled;
    if (!gate) return;
    gates().settled = undefined;
    gate.entered();
    await gate.promise;
  });
}
`;

const gate = () => {
  let resolve;
  let entered;
  const reached = new Promise((done) => { entered = done; });
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve, reached, entered };
};

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'pichamber-admission-e2e-'));
  const projectDir = join(root, 'project');
  const workerDir = join(root, 'worker');
  const agentDir = join(root, 'agent');
  await mkdir(projectDir, { recursive: true });
  await mkdir(workerDir, { recursive: true });
  await mkdir(join(agentDir, 'extensions'), { recursive: true });
  await writeFile(join(agentDir, 'extensions', 'faux-admission.ts'), extension(piAiFauxUrl(), workerDir));
  process.env.PICHAMBER_DATA_DIR = join(root, 'data');
  // Each settle wakes the parent at once, so wakes count run ends.
  disableHostGate(process.env.PICHAMBER_DATA_DIR, { wakes: { coalesceMs: 0 } });
  const endpoint = join(root, 'daemon.sock');
  const daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
  await daemon.start();
  const client = connectClient(endpoint);
  await client.authenticate();

  const created = await client.request('sessions.create', { cwd: projectDir, model: { providerId: 'faux', modelId: 'faux-1' } });
  const parentId = created.result.session.id;
  const results = () => client.events.filter((message) => message.event === 'extension.message'
    && message.payload?.sessionId === parentId
    && message.payload?.customType === 'pichamber.orchestration.events')
    .flatMap((message) => message.payload.details.events)
    .filter((event) => event.kind === 'run_finished');
  const answered = client.next((message) => message.event === 'assistant.message.end'
    && message.payload?.sessionId === parentId && message.payload?.text === 'PARENT GOT RESULT');
  await client.request('sessions.prompt', { sessionId: parentId, text: 'ORCHESTRATE one worker' });
  await answered;
  const workerId = results()[0].sessionId;

  const file = join(root, 'data', 'pi', 'orchestration-registry.json');
  const worker = async () => JSON.parse(await readFile(file, 'utf8')).workers[workerId];
  // Settles are applied, and their run ends delivered as wakes, in order.
  const delivered = (count) => client.next(() => results().length >= count, 30_000);
  // What Slice 2's worker_report records: the current run reported done.
  const reportDone = () => createOrchestrationRegistryStore({ file }).update((document) => {
    const entry = document.workers[workerId];
    entry.doneReported = entry.generation ?? true;
  });
  return { daemon, client, workerId, worker, delivered, reportDone };
};

describe('worker input admission through the real SDK', () => {
  let harness;
  const previousDataDir = process.env.PICHAMBER_DATA_DIR;

  afterEach(async () => {
    const gates = globalThis.__pichamberAdmission;
    gates?.response?.resolve();
    gates?.input?.resolve();
    gates?.settled?.resolve();
    delete globalThis.__pichamberAdmission;
    await harness?.client.close().catch(() => {});
    await harness?.daemon.stop();
    harness = undefined;
    if (previousDataDir === undefined) delete process.env.PICHAMBER_DATA_DIR;
    else process.env.PICHAMBER_DATA_DIR = previousDataDir;
  });

  it('keeps the slot for a follow-up that Pi starts as a new run after the run it was sent to settled (W1)', async () => {
    const gates = globalThis.__pichamberAdmission = {};
    harness = await setup();
    const { client, workerId, worker, delivered, reportDone } = harness;
    const running = [];
    gates.running = (text) => running.push(text);

    gates.response = gate();
    await client.request('sessions.prompt', { sessionId: workerId, text: 'RUN one' });
    await client.next(() => running.includes('RUN one'));
    await reportDone();
    // The follow-up is admitted while the run is live and waits in Pi's
    // input handlers.
    gates.input = gate();
    const followUp = client.request('sessions.followUp', { sessionId: workerId, text: 'RUN two' });
    await gates.input.reached;
    const first = gates.response;
    gates.response = gate();
    first.resolve();
    await delivered(2);
    gates.input.resolve();
    await expect(followUp).resolves.toMatchObject({ kind: 'response' });
    await client.next(() => running.includes('RUN two'));

    expect(await worker()).toMatchObject({ state: 'active' });
    gates.response.resolve();
    await delivered(3);
    expect(await worker()).toMatchObject({ state: 'active' });
  }, 120_000);

  it('keeps the slot for a prompt that Pi defers while the previous run settles (W2)', async () => {
    const gates = globalThis.__pichamberAdmission = {};
    harness = await setup();
    const { client, workerId, worker, delivered, reportDone } = harness;
    const running = [];
    gates.running = (text) => running.push(text);

    gates.response = gate();
    await client.request('sessions.prompt', { sessionId: workerId, text: 'RUN one' });
    await client.next(() => running.includes('RUN one'));
    await reportDone();
    const settling = gates.settled = gate();
    const first = gates.response;
    gates.response = gate();
    first.resolve();
    await settling.reached;
    // Pi defers this prompt and resolves it with no verdict.
    await expect(client.request('sessions.prompt', { sessionId: workerId, text: 'RUN two' })).resolves.toMatchObject({ kind: 'response' });
    settling.resolve();
    await client.next(() => running.includes('RUN two'));
    // The late verdict's run has no prompt of its own whose end proves its
    // end: it holds the slot and directory visibly (`unproven_run`).
    await vi.waitFor(async () => expect(await worker()).toMatchObject({ state: 'active', hold: { reason: 'unproven_run' } }));
    gates.response.resolve();
    await delivered(3);
    const settled = await worker();
    expect(settled).toMatchObject({ state: 'active', hold: { reason: 'unproven_run' } });
    expect(settled.admission).toBeUndefined();
  }, 120_000);
});
