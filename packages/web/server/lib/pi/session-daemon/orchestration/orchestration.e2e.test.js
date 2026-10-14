import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionDaemon } from '../session-daemon.js';
import { connectClient, credential, disableHostGate, markOrchestrator, piAiFauxUrl } from './e2e-support.js';
import { ORCHESTRATION_TOOLS, qualifiedToolName } from './tool-contracts.js';

// Orchestration through the real Pi SDK: the daemon's inline extension gives
// a session the mcp__pichamber__* tools, a scripted faux model calls
// session_spawn, and the worker's run end wakes the parent with a turn. Pi's
// faux provider stands in for a model; its script reacts to the transcript.

const fauxExtension = (fauxUrl, workerDir) => `
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from ${JSON.stringify(fauxUrl)};

const textOf = (message) => typeof message?.content === 'string'
  ? message.content
  : (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\\n');

const respond = async (context) => {
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
  // The known history poison: every run fails while the transcript holds it.
  if (messages.some((message) => textOf(message).includes('POISON'))) {
    return fauxAssistantMessage('broken', { stopReason: 'error', errorMessage: '400 invalid request: tool_result: all content must be type text if is_error is true' });
  }
  if (lastText.includes('FAIL NOW')) return fauxAssistantMessage('broken', { stopReason: 'error', errorMessage: 'invalid request: FAUX BROKEN' });
  if (lastText.includes('RUN AGAIN')) return fauxAssistantMessage('WORKER RAN AGAIN');
  if (lastText.includes('HOLD')) {
    await globalThis.__pichamberHold?.promise;
    return fauxAssistantMessage('PARENT HELD');
  }
  if (lastText.includes('run_finished: WORKER DONE')) return fauxAssistantMessage('PARENT GOT RESULT');
  if (lastText.includes('orchestration_digest')) return fauxAssistantMessage('PARENT WOKEN');
  return fauxAssistantMessage(fauxText('UNSCRIPTED'));
};

export default function (pi) {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 50 }, () => respond));
  pi.registerProvider(faux.provider);
  // A direct input that waits in the hook: accepted, but no run has started.
  pi.on('input', async (event) => {
    if (event.text.includes('GATE INPUT')) await globalThis.__pichamberGateInput?.promise;
    return { action: 'continue' };
  });
}
`;

describe('orchestration end-to-end through the real SDK', () => {
  let daemon;
  const previousDataDir = process.env.PICHAMBER_DATA_DIR;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    if (previousDataDir === undefined) delete process.env.PICHAMBER_DATA_DIR;
    else process.env.PICHAMBER_DATA_DIR = previousDataDir;
    globalThis.__pichamberHold?.resolve();
    delete globalThis.__pichamberHold;
    globalThis.__pichamberGateInput?.resolve();
    delete globalThis.__pichamberGateInput;
    delete globalThis.__pichamberOrchestrationLog;
  });

  const startDaemon = async ({ coalesceMs } = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-orchestration-e2e-'));
    const projectDir = join(root, 'project');
    const workerDir = join(root, 'worker');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(workerDir, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(join(agentDir, 'extensions', 'faux-orchestration.ts'), fauxExtension(piAiFauxUrl(), workerDir));
    process.env.PICHAMBER_DATA_DIR = join(root, 'data');
    disableHostGate(process.env.PICHAMBER_DATA_DIR, coalesceMs === undefined ? {} : { wakes: { coalesceMs } });

    const endpoint = join(root, 'daemon.sock');
    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();
    const createSession = async ({ orchestrator = true } = {}) => {
      const created = await client.request('sessions.create', { cwd: projectDir, model: { providerId: 'faux', modelId: 'faux-1' } });
      expect(created.kind).toBe('response');
      const sessionId = created.result.session.id;
      if (orchestrator) markOrchestrator(process.env.PICHAMBER_DATA_DIR, sessionId);
      return sessionId;
    };
    return { root, projectDir, workerDir, client, createSession };
  };

  it('spawns a worker without spawn rights and wakes the parent when its run ends', async () => {
    const { root, projectDir, workerDir, client, createSession } = await startDaemon();
    const parentId = await createSession();

    const delivered = client.next((message) => message.event === 'extension.message'
      && message.payload?.sessionId === parentId
      && message.payload?.customType === 'pichamber.orchestration.events', 30_000);
    const parentAnswered = client.next((message) => message.event === 'assistant.message.end'
      && message.payload?.sessionId === parentId
      && message.payload?.text === 'PARENT GOT RESULT', 30_000);
    await client.request('sessions.prompt', { sessionId: parentId, text: 'ORCHESTRATE one worker' });

    const result = await delivered;
    expect(result.payload.text).toContain('run_finished: WORKER DONE with');
    expect(result.payload.text).toContain('orchestration_digest');
    await parentAnswered;

    const log = globalThis.__pichamberOrchestrationLog ?? [];
    const parentTurn = log.find((entry) => entry.lastText.includes('ORCHESTRATE'));
    const workerTurn = log.find((entry) => entry.lastText.includes('WORKER TASK'));
    const all = ORCHESTRATION_TOOLS.filter((tool) => tool.orchestratorAllowed !== false).map((tool) => qualifiedToolName(tool.name));
    const workerAllowed = ORCHESTRATION_TOOLS.filter((tool) => tool.childAllowed !== false).map((tool) => qualifiedToolName(tool.name));

    // The orchestrator sees every tool but worker_report and the base
    // instructions in its system prompt; the worker never sees spawn, stop or
    // the digest, nor the instructions.
    expect(parentTurn.tools).toEqual(expect.arrayContaining(all));
    expect(parentTurn.tools).not.toContain(qualifiedToolName('worker_report'));
    expect(workerTurn.tools).toContain(qualifiedToolName('worker_report'));
    expect(workerTurn.tools).not.toContain(qualifiedToolName('orchestration_digest'));
    expect(parentTurn.hasInstructions).toBe(true);
    expect(parentTurn.lastText).toBe('ORCHESTRATE one worker');
    expect(workerTurn.tools).toEqual(expect.arrayContaining(workerAllowed));
    expect(workerTurn.tools).not.toContain(qualifiedToolName('session_spawn'));
    expect(workerTurn.tools).not.toContain(qualifiedToolName('session_stop'));
    expect(workerTurn.hasInstructions).toBe(false);

    // The worker is an ordinary session the owner can open, linked to its parent.
    const workerId = result.payload.details?.events?.[0]?.sessionId;
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
    // Against the pinned SDK catalog: Claude 5.5 always thinks (no off) and
    // Opus takes xhigh, and every Claude role default is a level its model supports.
    const catalog = capabilities.result.value.models;
    const anthropic = (modelId) => catalog.find((model) => model.providerId === 'anthropic' && model.modelId === modelId);
    expect(anthropic('claude-opus-5-5')?.thinkingLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    for (const role of Object.values(capabilities.result.value.roles).filter((entry) => entry.modelId.startsWith('claude-'))) {
      expect(anthropic(role.modelId)?.thinkingLevels).toContain(role.thinking);
    }
    expect(capabilities.result.value.host).toEqual(expect.objectContaining({ cpuCount: expect.any(Number), memory: expect.objectContaining({ freeBytes: expect.any(Number) }) }));
    const workerSpawn = await client.request('orchestration.call', { sessionId: workerId, tool: 'session_spawn', args: { cwd: workerDir, task: 'nested' } });
    expect(workerSpawn.result.error).toMatchObject({ code: expect.stringMatching(/^ORCHESTRATION_/) });

    // The durable registry holds the worker, made active by its settled first turn.
    const registryFile = join(root, 'data', 'pi', 'orchestration-registry.json');
    await vi.waitFor(async () => {
      const registry = JSON.parse(await readFile(registryFile, 'utf8'));
      expect(registry.workers[workerId]).toMatchObject({ orchestratorSessionId: parentId, state: 'active' });
    }, { timeout: 10_000 });

    // A successor takes the worker over through the IPC path; the old
    // orchestrator then cannot stop it, and a worker cannot take over.
    const successorId = await createSession();
    const workerTakeover = await client.request('orchestration.call', { sessionId: workerId, tool: 'orchestration_takeover', args: { fromSessionId: parentId } });
    expect(workerTakeover.result.error).toMatchObject({ code: 'ORCHESTRATION_FORBIDDEN' });
    let takeover;
    await vi.waitFor(async () => {
      takeover = await client.request('orchestration.call', { sessionId: successorId, tool: 'orchestration_takeover', args: { fromSessionId: parentId } });
      expect(takeover.result.error).toBeUndefined();
    }, { timeout: 10_000 });
    expect(takeover.result.value).toMatchObject({ fromSessionId: parentId, workers: [workerId] });
    const oldStop = await client.request('orchestration.call', { sessionId: parentId, tool: 'session_stop', args: { sessionId: workerId } });
    expect(oldStop.result.error).toMatchObject({ code: 'ORCHESTRATION_FORBIDDEN' });
    const listed = await client.request('orchestration.call', { sessionId: successorId, tool: 'session_list', args: {} });
    expect(listed.result.value.sessions).toEqual([expect.objectContaining({ sessionId: workerId, lifecycle: 'active' })]);

    // A session without the mark sees no orchestration tool and no
    // instructions, and the IPC path refuses it too.
    const plainId = await createSession({ orchestrator: false });
    const plainAnswered = client.next((message) => message.event === 'assistant.message.end'
      && message.payload?.sessionId === plainId, 30_000);
    await client.request('sessions.prompt', { sessionId: plainId, text: 'PLAIN SESSION' });
    await plainAnswered;
    const plainTurn = globalThis.__pichamberOrchestrationLog.find((entry) => entry.lastText === 'PLAIN SESSION');
    expect(plainTurn.tools.filter((name) => name.startsWith('mcp__pichamber__'))).toEqual([]);
    expect(plainTurn.hasInstructions).toBe(false);
    const plainCall = await client.request('orchestration.call', { sessionId: plainId, tool: 'orchestration_capabilities', args: {} });
    expect(plainCall.result.error).toMatchObject({ code: 'ORCHESTRATION_FORBIDDEN' });

    await client.close();
  }, 120_000);

  it('rewinds a worker whose history fails every run and runs it again from there', async () => {
    const { root, client, createSession } = await startDaemon({ coalesceMs: 100 });
    const parentId = await createSession();
    const call = async (sessionId, tool, args) => (await client.request('orchestration.call', { sessionId, tool, args })).result;
    const wakes = () => client.events.filter((message) => message.event === 'extension.message'
      && message.payload?.sessionId === parentId
      && message.payload?.customType === 'pichamber.orchestration.events')
      .flatMap((message) => message.payload.details.events);
    const replies = (sessionId, text) => client.events.filter((message) => message.event === 'assistant.message.end'
      && message.payload?.sessionId === sessionId && message.payload?.text === text).length;
    const reached = (check) => vi.waitFor(() => expect(check(), String(check)).toBe(true), { timeout: 30_000, interval: 50 });

    await client.request('sessions.prompt', { sessionId: parentId, text: 'ORCHESTRATE one worker' });
    await reached(() => replies(parentId, 'PARENT GOT RESULT') === 1);
    const workerId = wakes()[0].sessionId;

    await client.request('sessions.prompt', { sessionId: workerId, text: 'POISON' });
    await reached(() => wakes().some((event) => event.kind === 'run_failed'));
    expect(wakes().find((event) => event.kind === 'run_failed').reason).toContain('all content must be type text');

    // Rewind to the entry before the poisoned message, which the read shows by id.
    const read = (await call(parentId, 'session_read', { sessionId: workerId })).value;
    const poisoned = read.messages.findIndex((message) => message.role === 'user' && message.text === 'POISON');
    expect(poisoned).toBeGreaterThan(0);
    const before = read.messages[poisoned - 1];
    expect(before.text).toContain('WORKER DONE');
    // A direct prompt held in Pi's input hook has no run yet but will start one: no rewind under it.
    let release;
    globalThis.__pichamberGateInput = { promise: new Promise((resolve) => { release = resolve; }), resolve: () => release() };
    // The UI's own connection: this daemon answers one connection's requests in order.
    const ui = connectClient(join(root, 'daemon.sock'));
    await ui.authenticate();
    const gated = ui.request('sessions.prompt', { sessionId: workerId, text: 'GATE INPUT' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const gatedRewind = await call(parentId, 'session_rewind', { sessionId: workerId, entryId: before.entryId, prompt: 'RUN AGAIN' });
    expect(gatedRewind.error).toMatchObject({ code: 'ORCHESTRATION_SESSION_BUSY' });
    release();
    await gated;
    await ui.close();
    await reached(() => replies(workerId, 'UNSCRIPTED') + wakes().filter((event) => event.kind === 'run_failed').length >= 2);
    const gatedRead = (await call(parentId, 'session_read', { sessionId: workerId })).value;
    expect(gatedRead.messages.map((message) => message.text)).toContain('GATE INPUT');

    const foreign = await call(workerId, 'session_rewind', { sessionId: workerId, entryId: before.entryId });
    expect(foreign.error).toMatchObject({ code: 'ORCHESTRATION_FORBIDDEN' });
    const missing = await call(parentId, 'session_rewind', { sessionId: workerId, entryId: 'no-such-entry' });
    expect(missing.error).toMatchObject({ code: 'SESSION_TREE_NOT_FOUND' });

    const rewound = await call(parentId, 'session_rewind', { sessionId: workerId, entryId: before.entryId, prompt: 'RUN AGAIN', clientRequestId: 'rewind-1' });
    expect(rewound.error).toBeUndefined();
    expect(rewound.value).toMatchObject({ sessionId: workerId, newLeafId: before.entryId, prompted: true });
    await reached(() => replies(workerId, 'WORKER RAN AGAIN') === 1);
    const after = (await call(parentId, 'session_read', { sessionId: workerId })).value;
    expect(after.outcome).toBe('completed');
    expect(after.messages.map((message) => message.text)).not.toContain('POISON');

    // The same call again (a lost answer) replays; it neither moves the leaf nor prompts twice.
    const replayed = await call(parentId, 'session_rewind', { sessionId: workerId, entryId: before.entryId, prompt: 'RUN AGAIN', clientRequestId: 'rewind-1' });
    expect(replayed.value).toMatchObject({ newLeafId: before.entryId, prompted: true, deduplicated: true });
    const kept = (await call(parentId, 'session_read', { sessionId: workerId })).value;
    expect(kept.messages.map((message) => message.text)).toEqual(after.messages.map((message) => message.text));
    expect(replies(workerId, 'WORKER RAN AGAIN')).toBe(1);

    await client.close();
  }, 120_000);

  it('wakes an idle orchestrator per question and failure, a busy one once per burst, and the new owner after a takeover', async () => {
    const { client, createSession } = await startDaemon({ coalesceMs: 300 });
    const parentId = await createSession();
    const wakesOf = (sessionId) => client.events.filter((message) => message.event === 'extension.message'
      && message.payload?.sessionId === sessionId
      && message.payload?.customType === 'pichamber.orchestration.events')
      .map((message) => message.payload.details.events.map(({ sessionId: worker, kind, reason }) => ({ sessionId: worker, kind, reason })));
    const replies = (sessionId, text) => client.events.filter((message) => message.event === 'assistant.message.end'
      && message.payload?.sessionId === sessionId && message.payload?.text === text).length;
    // Some conditions change without a daemon message (the faux log), so poll.
    const reached = (check) => vi.waitFor(() => expect(check(), String(check)).toBe(true), { timeout: 30_000, interval: 50 });

    await client.request('sessions.prompt', { sessionId: parentId, text: 'ORCHESTRATE one worker' });
    await reached(() => replies(parentId, 'PARENT GOT RESULT') === 1);
    const workerId = wakesOf(parentId)[0][0].sessionId;
    expect(wakesOf(parentId)).toEqual([[{ sessionId: workerId, kind: 'run_finished', reason: expect.stringContaining('WORKER DONE') }]]);

    // A question through worker_report wakes the idle orchestrator.
    const asked = await client.request('orchestration.call', { sessionId: workerId, tool: 'worker_report', args: { kind: 'question', summary: 'WHICH BRANCH', audience: 'orchestrator' } });
    expect(asked.result.error).toBeUndefined();
    const questionId = asked.result.value.openQuestion;
    await reached(() => replies(parentId, 'PARENT WOKEN') === 1);
    expect(wakesOf(parentId)[1]).toEqual([{ sessionId: workerId, kind: 'question', reason: 'WHICH BRANCH' }]);

    // A run that ends in a provider error Pi does not retry is a failure.
    await client.request('sessions.prompt', { sessionId: workerId, text: 'FAIL NOW' });
    await reached(() => replies(parentId, 'PARENT WOKEN') === 2);
    expect(wakesOf(parentId)[2]).toEqual([{ sessionId: workerId, kind: 'run_failed', reason: expect.stringContaining('FAUX BROKEN') }]);

    // While the orchestrator runs, three events wait and arrive as one message after its run.
    let release;
    globalThis.__pichamberHold = { promise: new Promise((done) => { release = done; }), resolve: () => release() };
    await client.request('sessions.prompt', { sessionId: parentId, text: 'HOLD while workers report' });
    await reached(() => (globalThis.__pichamberOrchestrationLog ?? []).some((entry) => entry.lastText === 'HOLD while workers report'));
    await client.request('sessions.prompt', { sessionId: workerId, text: 'RUN AGAIN' });
    await reached(() => replies(workerId, 'WORKER RAN AGAIN') === 1);
    await client.request('sessions.prompt', { sessionId: workerId, text: 'FAIL NOW' });
    // The worker's fourth reply: done, failed, ran again, failed.
    await reached(() => client.events.filter((message) => message.event === 'assistant.message.end'
      && message.payload?.sessionId === workerId).length === 4);
    const blocked = await client.request('orchestration.call', { sessionId: workerId, tool: 'worker_report', args: { kind: 'blocked', summary: 'NEED ACCESS', audience: 'orchestrator', resolves: questionId } });
    expect(blocked.result.error).toBeUndefined();
    // Longer than the coalescing window: a wake now would already be here.
    await new Promise((done) => { setTimeout(done, 1_000); });
    expect(wakesOf(parentId)).toHaveLength(3);
    release();
    await reached(() => replies(parentId, 'PARENT WOKEN') === 3);
    expect(wakesOf(parentId)).toHaveLength(4);
    // The owner's own prompts (RUN AGAIN) end without a run_finished (#156); a
    // blocker is its own kind. A run end is applied after the run settles, so
    // it can follow a later report.
    expect(wakesOf(parentId)[3].map((event) => event.kind).sort()).toEqual(['blocked', 'run_failed']);

    // After a takeover the next wake goes to the new owner.
    const successorId = await createSession();
    const takeover = await client.request('orchestration.call', { sessionId: successorId, tool: 'orchestration_takeover', args: { fromSessionId: parentId } });
    expect(takeover.result.error).toBeUndefined();
    // The last writer decides (#156): a run the owner prompts and a question
    // for the owner wake nobody; a question for the orchestrator wakes the new owner.
    await client.request('sessions.prompt', { sessionId: workerId, text: 'RUN AGAIN' });
    await reached(() => replies(workerId, 'WORKER RAN AGAIN') === 2);
    const forOwner = await client.request('orchestration.call', { sessionId: workerId, tool: 'worker_report', args: { kind: 'question', summary: 'OWNER ONLY', audience: 'owner', resolves: blocked.result.value.openQuestion } });
    expect(forOwner.result.error).toBeUndefined();
    const forOrchestrator = await client.request('orchestration.call', { sessionId: workerId, tool: 'worker_report', args: { kind: 'question', summary: 'ORCHESTRATOR ONLY', audience: 'orchestrator', resolves: forOwner.result.value.openQuestion } });
    expect(forOrchestrator.result.error).toBeUndefined();
    await reached(() => wakesOf(successorId).length === 1);
    expect(wakesOf(successorId)[0]).toEqual([{ sessionId: workerId, kind: 'question', reason: 'ORCHESTRATOR ONLY' }]);
    expect(wakesOf(parentId)).toHaveLength(4);

    await client.close();
  }, 120_000);
});
