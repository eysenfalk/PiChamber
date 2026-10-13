import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createPiSessionRuntime } from '../session-daemon.js';
import { piAiFauxUrl } from './e2e-support.js';
import { abortBoundRun, bindStartedRun, isSettleFinal } from './run-binding.js';

const gate = () => {
  let resolve;
  let entered;
  const reached = new Promise((done) => { entered = done; });
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve, reached, entered };
};

const textOf = (message) => typeof message?.content === 'string'
  ? message.content
  : (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');

// Pins the SDK order run-binding.js relies on (Pi 1.1.0): Pi starts the run
// in the same synchronous step that reports `started`, and a prompt that
// waited in `before_agent_start` while another run started gets no run.
describe('run binding through the real SDK', () => {
  let root;
  let runtime;
  const gates = {};

  afterEach(async () => {
    for (const held of Object.values(gates)) held.resolve();
    for (const key of Object.keys(gates)) delete gates[key];
    await runtime?.dispose();
    runtime = undefined;
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  const setup = async () => {
    const { fauxAssistantMessage, fauxProvider } = await import(piAiFauxUrl());
    root = await mkdtemp(join(tmpdir(), 'pichamber-run-binding-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const respond = async (context) => {
      const text = textOf((context.messages ?? []).filter((message) => message.role === 'user').at(-1));
      const held = gates[`provider ${text}`];
      if (held) { held.entered(); await held.promise; }
      return fauxAssistantMessage(`RAN ${text}`);
    };
    const extension = (pi) => {
      const faux = fauxProvider();
      faux.setResponses(Array.from({ length: 10 }, () => respond));
      pi.registerProvider(faux.provider);
      pi.on('before_agent_start', async (event) => {
        const held = gates[`start ${event.prompt}`];
        if (held) { held.entered(); await held.promise; }
      });
    };
    runtime = await createPiSessionRuntime({ cwd, agentDir }, { extensionFactories: [extension] });
    const { session } = runtime;
    await session.setModel(session.modelRuntime.getModel('faux', 'faux-1'));
    const prompt = (text, onStarted) => session.prompt(text, {
      expandPromptTemplates: false,
      source: 'extension',
      preflightResult: (outcome) => { if (outcome === 'started') onStarted?.(); },
    });
    return { session, prompt };
  };

  it('binds a started prompt to its own run and aborts only that run', async () => {
    const { session, prompt } = await setup();
    gates['provider A'] = gate();
    let bound;
    const running = prompt('A', () => { bound = bindStartedRun(session); });
    await gates['provider A'].reached;
    const signal = await bound;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal).toBe(session.agent.signal);
    expect(abortBoundRun(session, signal)).toBe(true);
    expect(signal.aborted).toBe(true);
    gates['provider A'].resolve();
    await running.catch(() => {});
  });

  it('binds no run for a prompt that waited in before_agent_start while another prompt\'s run started', async () => {
    const { session, prompt } = await setup();
    gates['start A'] = gate();
    gates['provider B'] = gate();
    let boundA;
    let boundB;
    // A passes Pi's isStreaming check and waits in before_agent_start.
    const promptA = prompt('A', () => { boundA = bindStartedRun(session); }).catch((error) => error);
    await gates['start A'].reached;
    // B starts a real run meanwhile and is held in the provider.
    const promptB = prompt('B', () => { boundB = bindStartedRun(session); });
    await gates['provider B'].reached;
    const signalB = await boundB;
    expect(signalB).toBe(session.agent.signal);
    // A reports `started` although B owns the agent's run.
    gates['start A'].resolve();
    await promptA;
    expect(boundA).toBeDefined();
    const signalA = await boundA;
    expect(signalA).toBeNull();
    expect(abortBoundRun(session, signalA)).toBe(false);
    expect(signalB.aborted).toBe(false);
    gates['provider B'].resolve();
    await promptB;
    expect(signalB.aborted).toBe(false);
    const replies = session.messages.filter((message) => message.role === 'assistant').map(textOf);
    expect(replies).toContain('RAN B');
    expect(replies).not.toContain('RAN A');
  });

  // What the daemon sees at its `agent_settled` boundary (R8-S2).
  const settles = (session) => {
    const seen = [];
    session.subscribe((event) => {
      if (event.type === 'agent_settled') seen.push({ final: isSettleFinal(session), signal: session.agent.signal });
    });
    return seen;
  };

  it('marks the settle Pi emits for a rejected prompt while another run is live as no completion', async () => {
    const { session, prompt } = await setup();
    const seen = settles(session);
    gates['start A'] = gate();
    gates['provider B'] = gate();
    const promptA = prompt('A').catch((error) => error);
    await gates['start A'].reached;
    const promptB = prompt('B');
    await gates['provider B'].reached;
    const signalB = session.agent.signal;
    // A's rejected prompt still emits agent_settled from its finally, while
    // B's run holds the agent.
    gates['start A'].resolve();
    await promptA;
    await new Promise((done) => setTimeout(done, 20));
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.every((entry) => entry.final === false && entry.signal === signalB)).toBe(true);
    expect(signalB.aborted).toBe(false);
    // B's own end is the completion.
    const before = seen.length;
    gates['provider B'].resolve();
    await promptB;
    await new Promise((done) => setTimeout(done, 20));
    expect(seen.slice(before).at(-1)).toEqual({ final: true, signal: undefined });
  });

  it('keeps the signal of an aborted run until that run ended, and gives the next run a new one', async () => {
    const { session, prompt } = await setup();
    const seen = settles(session);
    gates['provider A'] = gate();
    const running = prompt('A').catch(() => {});
    await gates['provider A'].reached;
    const signalA = session.agent.signal;
    expect(abortBoundRun(session, signalA)).toBe(true);
    // Aborted, but the run has not ended: still no completion.
    expect(signalA.aborted).toBe(true);
    expect(isSettleFinal(session)).toBe(false);
    gates['provider A'].resolve();
    await running;
    await new Promise((done) => setTimeout(done, 20));
    expect(isSettleFinal(session)).toBe(true);
    expect(seen.at(-1)).toEqual({ final: true, signal: undefined });
    // The next run has its own signal, so the aborted one never matches it.
    gates['provider B'] = gate();
    const next = prompt('B');
    await gates['provider B'].reached;
    expect(session.agent.signal).toBeInstanceOf(AbortSignal);
    expect(session.agent.signal).not.toBe(signalA);
    expect(abortBoundRun(session, signalA)).toBe(false);
    gates['provider B'].resolve();
    await next;
  });
});
