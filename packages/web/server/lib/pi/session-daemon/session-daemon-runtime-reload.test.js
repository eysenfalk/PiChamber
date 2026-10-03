import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionDaemon } from './session-daemon.js';
import { requestSessionDaemon } from './ipc-client.js';

const credential = 'a-private-daemon-credential';

class FakeSession {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.isStreaming = false;
    this.isCompacting = false;
    this.listeners = new Set();
    this.reloadCount = 0;
    this.reloadError = null;
    this.model = { provider: 'test', id: 'model' };
    this.thinkingLevel = 'low';
    this.sessionManager = {
      getSessionFile: () => undefined,
      getHeader: () => ({ timestamp: '2026-01-01T00:00:00.000Z' }),
      getEntries: () => [],
      getEntry: () => undefined,
      getLeafId: () => 'fake-entry',
      getTree: () => [],
      appendSessionInfo: () => undefined,
      getSessionName: () => undefined,
    };
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) listener(event); }
  async reload() {
    this.reloadCount += 1;
    if (this.reloadError) throw this.reloadError;
  }
  async prompt() {}
  async sendUserMessage() {}
  async abort() {}
  async compact() {}
  getSteeringMessages() { return []; }
  getFollowUpMessages() { return []; }
}

describe('runtime.reloadResources', () => {
  const roots = [];
  let daemon;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = undefined;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const startDaemon = async (sessions) => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-runtime-reload-'));
    roots.push(root);
    await mkdir(join(root, 'agent'), { recursive: true });
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\pichamber-runtime-reload-${Math.random().toString(36).slice(2)}`
      : join(root, 'daemon.sock');
    const queue = [...sessions];
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      agentDir: join(root, 'agent'),
      createRuntime: async () => ({ cwd: root, session: queue.shift(), async dispose() {} }),
    });
    await daemon.start();
    const request = (command, payload = {}) => requestSessionDaemon({ endpoint, credential, command, payload });
    for (let index = 0; index < sessions.length; index += 1) await request('sessions.create', { cwd: root });
    return { request, root };
  };

  it('advertises the command', async () => {
    const { request } = await startDaemon([new FakeSession('s1')]);
    expect((await request('runtime.health')).capabilities).toContain('runtime.reloadResources');
  });

  it('reloads every idle session at once without recreating runtimes', async () => {
    const first = new FakeSession('s1');
    const second = new FakeSession('s2');
    const { request } = await startDaemon([first, second]);
    await expect(request('runtime.reloadResources')).resolves.toEqual({ reloaded: 2, deferred: 0, failed: 0 });
    expect([first.reloadCount, second.reloadCount]).toEqual([1, 1]);
  });

  it('defers a streaming session and reloads it when its turn ends, interrupting nothing', async () => {
    const idle = new FakeSession('s1');
    const busy = new FakeSession('s2');
    const { request } = await startDaemon([idle, busy]);
    busy.isStreaming = true;

    await expect(request('runtime.reloadResources')).resolves.toEqual({ reloaded: 1, deferred: 1, failed: 0 });
    expect([idle.reloadCount, busy.reloadCount]).toEqual([1, 0]);

    busy.isStreaming = false;
    busy.emit({ type: 'agent_settled' });
    await expect.poll(() => busy.reloadCount).toBe(1);
    expect(idle.reloadCount).toBe(1);
  });

  it('defers a compacting session', async () => {
    const compacting = new FakeSession('s1');
    const { request } = await startDaemon([compacting]);
    compacting.isCompacting = true;
    await expect(request('runtime.reloadResources')).resolves.toEqual({ reloaded: 0, deferred: 1, failed: 0 });
    expect(compacting.reloadCount).toBe(0);
  });

  it('counts a failing reload without blocking the others, and retries it at the next safe edge', async () => {
    const broken = new FakeSession('s1');
    const healthy = new FakeSession('s2');
    const { request } = await startDaemon([broken, healthy]);
    broken.reloadError = new Error('reload failed');

    await expect(request('runtime.reloadResources')).resolves.toEqual({ reloaded: 1, deferred: 0, failed: 1 });
    expect(healthy.reloadCount).toBe(1);

    broken.reloadError = null;
    await expect(request('runtime.reloadResources')).resolves.toEqual({ reloaded: 2, deferred: 0, failed: 0 });
  });

  it('reports zero everywhere when no session is loaded', async () => {
    const { request } = await startDaemon([]);
    await expect(request('runtime.reloadResources')).resolves.toEqual({ reloaded: 0, deferred: 0, failed: 0 });
  });
});
