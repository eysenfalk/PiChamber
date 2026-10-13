import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionDaemon } from '../session-daemon.js';
import { connectClient, credential, piAiFauxUrl } from './e2e-support.js';
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
    if (gates().fail?.delete(text)) {
      gates().failed?.();
      return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'overloaded_error: try again' });
    }
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
  // One-shot: the first RUN prompt after the gate is set waits after Pi's
  // isStreaming check.
  pi.on('before_agent_start', async (event) => {
    const gate = gates().start;
    if (!gate || !String(event.prompt).startsWith('RUN ')) return;
    gates().start = undefined;
    gate.entered();
    await gate.promise;
  });
  // One-shot: the first run that ends after the gate is set waits before its
  // settle; its agent signal is gone by then.
  pi.on('agent_before_settle', async () => {
    const gate = gates().beforeSettle;
    if (!gate) return;
    gates().beforeSettle = undefined;
    gate.entered();
    await gate.promise;
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
  const endpoint = join(root, 'daemon.sock');
  const daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
  await daemon.start();
  const client = connectClient(endpoint);
  await client.authenticate();

  const created = await client.request('sessions.create', { cwd: projectDir, model: { providerId: 'faux', modelId: 'faux-1' } });
  const parentId = created.result.session.id;
  const results = () => client.events.filter((message) => message.event === 'extension.message'
    && message.payload?.sessionId === parentId
    && message.payload?.customType === 'pichamber.orchestration.result');
  const answered = client.next((message) => message.event === 'assistant.message.end'
    && message.payload?.sessionId === parentId && message.payload?.text === 'PARENT GOT RESULT');
  await client.request('sessions.prompt', { sessionId: parentId, text: 'ORCHESTRATE one worker' });
  await answered;
  const workerId = results()[0].payload.details.sessionId;

  const file = join(root, 'data', 'pi', 'orchestration-registry.json');
  const worker = async () => JSON.parse(await readFile(file, 'utf8')).workers[workerId];
  // Settles are applied, and their results delivered, in order.
  const delivered = (count) => client.next(() => results().length >= count, 30_000);
  // What Slice 2's worker_report records: the current run reported done.
  const reportDone = () => createOrchestrationRegistryStore({ file }).update((document) => {
    const entry = document.workers[workerId];
    entry.doneReported = entry.generation ?? true;
  });
  return { daemon, endpoint, client, workerId, worker, results, delivered, reportDone };
};

describe('worker input admission through the real SDK', () => {
  let harness;
  const previousDataDir = process.env.PICHAMBER_DATA_DIR;

  afterEach(async () => {
    const gates = globalThis.__pichamberAdmission;
    gates?.response?.resolve();
    gates?.input?.resolve();
    gates?.settled?.resolve();
    gates?.start?.resolve();
    gates?.beforeSettle?.resolve();
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

  // R9-B1: A reports `started` without a run of its own while B runs, B
  // reports done after A's verdict, B's attempt fails and B waits to retry
  // with no run signal, then A's settle arrives. Only B's own end may end B.
  it('lets no settle of another prompt end a run that waits to retry, or take its done report', async () => {
    const gates = globalThis.__pichamberAdmission = {};
    harness = await setup();
    const { client, workerId, worker, results, delivered, reportDone } = harness;
    const running = [];
    gates.running = (text) => running.push(text);
    const idles = () => client.events.filter((message) => message.event === 'session.lifecycle'
      && message.payload?.sessionId === workerId && message.payload?.state === 'idle').length;

    // A passes Pi's isStreaming check and waits in before_agent_start.
    const startA = gates.start = gate();
    const promptA = client.request('sessions.prompt', { sessionId: workerId, text: 'RUN A' }).catch((error) => error);
    await startA.reached;
    gates.response = gate();
    gates.fail = new Set(['RUN B']);
    const failed = gate();
    gates.failed = failed.entered;
    // B comes from a second client: one connection answers its requests in
    // order, and A's is still open.
    const other = connectClient(harness.endpoint);
    await other.authenticate();
    await expect(other.request('sessions.prompt', { sessionId: workerId, text: 'RUN B' })).resolves.toMatchObject({ kind: 'response' });
    await other.close();
    await client.next(() => running.includes('RUN B'));
    // A reports started into B's run; its settle waits in a hook.
    const settleA = gates.settled = gate();
    startA.resolve();
    await settleA.reached;
    await new Promise((done) => setTimeout(done, 200));
    await reportDone();
    const before = { results: results().length, idles: idles() };
    gates.response.resolve();
    await failed.reached;
    await new Promise((done) => setTimeout(done, 100));
    settleA.resolve();
    await promptA;
    await new Promise((done) => setTimeout(done, 300));
    // B waits to retry: A's settle ended nothing.
    expect(running.filter((text) => text === 'RUN B')).toHaveLength(1);
    expect(await worker()).toMatchObject({ state: 'active' });
    expect(results().length).toBe(before.results);
    expect(idles()).toBe(before.idles);
    // B's own end applies its done report and delivers its result.
    await delivered(before.results + 1);
    expect(running.filter((text) => text === 'RUN B')).toHaveLength(2);
    await vi.waitFor(async () => expect(await worker()).toMatchObject({ state: 'done' }));
    expect(results()).toHaveLength(before.results + 1);
  }, 120_000);

  // R9 addendum: the native side of a settle (idle, cleanup, the result) of a
  // tracked worker run waits for that run's own end.
  it('publishes no idle for a worker while its run waits before its settle and another prompt settles', async () => {
    const gates = globalThis.__pichamberAdmission = {};
    harness = await setup();
    const { client, workerId, worker, results, delivered } = harness;
    const running = [];
    gates.running = (text) => running.push(text);
    const idles = () => client.events.filter((message) => message.event === 'session.lifecycle'
      && message.payload?.sessionId === workerId && message.payload?.state === 'idle').length;

    const startA = gates.start = gate();
    const promptA = client.request('sessions.prompt', { sessionId: workerId, text: 'RUN A' }).catch((error) => error);
    await startA.reached;
    gates.response = gate();
    const other = connectClient(harness.endpoint);
    await other.authenticate();
    await expect(other.request('sessions.prompt', { sessionId: workerId, text: 'RUN B' })).resolves.toMatchObject({ kind: 'response' });
    await other.close();
    await client.next(() => running.includes('RUN B'));
    // A reports started into B's run; its settle waits in a hook.
    const settleA = gates.settled = gate();
    startA.resolve();
    await settleA.reached;
    const before = { results: results().length, idles: idles() };
    // B's run ends and waits before its settle: no agent signal, no retry.
    const beforeSettleB = gates.beforeSettle = gate();
    gates.response.resolve();
    await beforeSettleB.reached;
    settleA.resolve();
    await promptA;
    await new Promise((done) => setTimeout(done, 300));
    expect(idles()).toBe(before.idles);
    expect(results().length).toBe(before.results);
    expect(await worker()).toMatchObject({ state: 'active' });
    // B's own end publishes idle and delivers its result.
    beforeSettleB.resolve();
    await delivered(before.results + 1);
    await vi.waitFor(() => expect(idles()).toBe(before.idles + 1));
    expect(running.filter((text) => text === 'RUN B')).toHaveLength(1);
  }, 120_000);
});
