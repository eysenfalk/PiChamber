import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createSessionDaemon } from './session-daemon.js';
import { getPiSessionDirectory } from './session-jsonl.js';

/**
 * Regression coverage for the daemon's default runtime (#164, #171).
 *
 * Calls without a session id (`providers.list`, and through it the model
 * lookup of every orchestration spawn) run on the default runtime. When none
 * is live, the daemon reopens the dormant session. These tests delete or
 * remove that session's file or directory and check that such a call still
 * gets a runtime instead of SESSION_RUNTIME_CONFLICT or
 * SESSION_JSONL_UNREADABLE.
 *
 * The fake runtime factory rejects a working directory that does not exist,
 * like the Pi SDK does ("Stored session working directory does not exist").
 */

const credential = 'default-runtime-regression-secret';

const testDaemonEndpoint = (root) => {
  if (process.platform === 'win32') return `\\\\.\\pipe\\pichamber-default-runtime-${process.pid}-${Math.random().toString(16).slice(2)}`;
  return join(root, 'daemon.sock');
};

const daemonRequest = (endpoint, command, payload, timeoutMs = 20_000) => new Promise((resolve, reject) => {
  const requestId = `req-${Math.random().toString(16).slice(2)}`;
  const socket = createConnection({ path: endpoint });
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let authenticated = false;
  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      socket.destroy();
      reject(new Error(`Timed out waiting for daemon ${command}`));
    }
  }, timeoutMs);
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    callback(value);
  };
  socket.once('error', (error) => finish(reject, error));
  socket.on('connect', () => {
    socket.write(`${JSON.stringify({ kind: 'authenticate', credential })}\n`);
  });
  socket.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      if (!authenticated) {
        if (frame.kind !== 'authenticated') {
          finish(reject, new Error(`Daemon authentication failed for ${command}`));
          return;
        }
        authenticated = true;
        socket.write(`${JSON.stringify({
          protocolVersion: 1, kind: 'request', requestId, command, payload,
        })}\n`);
        continue;
      }
      if (frame.kind === 'response' && frame.requestId === requestId) {
        finish(resolve, { ok: true, result: frame.result });
        return;
      }
      if (frame.kind === 'error') {
        finish(resolve, { ok: false, error: frame.error });
        return;
      }
    }
  });
  socket.on('close', () => {
    if (!settled && authenticated) finish(reject, new Error(`Daemon connection closed waiting for ${command}`));
  });
});

async function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 10, message = 'Timed out' } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

class FakeSession {
  constructor(sessionId, sessionFile, cwd) {
    this.sessionId = sessionId;
    this.isStreaming = false;
    this.isCompacting = false;
    this.listeners = new Set();
    this.model = { provider: 'test', id: 'model' };
    this.thinkingLevel = 'low';
    this.modelRuntime = {
      getModel: (providerId, modelId) => ({ provider: providerId, id: modelId }),
      getModels: () => [{ provider: 'test', id: 'model', name: 'Test model', contextWindow: 128_000, reasoning: true }],
      getProvider: (providerId) => (providerId === 'test' ? ({ name: 'Test provider' }) : undefined),
      getProviderAuthStatus: () => ({ configured: true }),
    };
    this.sessionManager = {
      getSessionFile: () => sessionFile,
      getHeader: () => ({ type: 'session', id: sessionId, cwd, timestamp: '2026-01-01T00:00:00.000Z' }),
      getEntries: () => [],
      getLeafId: () => undefined,
      getTree: () => [],
      appendSessionInfo: () => {},
      getSessionName: () => undefined,
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async abort() { this.isStreaming = false; }

  getSteeringMessages() { return []; }

  getFollowUpMessages() { return []; }
}

class FakeRuntime {
  constructor({ cwd, session }) {
    this.cwd = cwd;
    this.session = session;
    this.disposed = false;
  }

  async dispose() {
    this.disposed = true;
  }
}

const writeSessionFile = async ({ agentDir, cwd, sessionId }) => {
  const directory = getPiSessionDirectory({ cwd, agentDir });
  await mkdir(directory, { recursive: true });
  const file = join(directory, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
  await writeFile(file, `${JSON.stringify({ type: 'session', id: sessionId, cwd, timestamp: '2026-01-01T00:00:00.000Z' })}\n`);
  return file;
};

describe('default runtime after session deletion', () => {
  let tempRoot;
  let daemon;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = undefined;
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    tempRoot = undefined;
  });

  const setup = async ({ idleTimeoutMs = 60_000 } = {}) => {
    tempRoot = await mkdtemp(join(tmpdir(), 'pichamber-default-runtime-'));
    const home = join(tempRoot, 'home');
    const agentDir = join(tempRoot, 'agent');
    const endpoint = testDaemonEndpoint(tempRoot);
    await mkdir(home, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const runtimes = [];
    const hold = { enabled: false, pending: [] };
    let freshSessions = 0;
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: home,
      agentDir,
      idleTimeoutMs,
      createRuntime: async ({ cwd: runtimeCwd, sessionFile }) => {
        if (hold.enabled) await new Promise((resolve) => hold.pending.push(resolve));
        if (!existsSync(runtimeCwd)) throw new Error(`Stored session working directory does not exist: ${runtimeCwd}`);
        const sessionId = sessionFile
          ? JSON.parse(readFileSync(sessionFile, 'utf8').split('\n')[0]).id
          : `fresh-${freshSessions += 1}`;
        const created = new FakeRuntime({ cwd: runtimeCwd, session: new FakeSession(sessionId, sessionFile, runtimeCwd) });
        runtimes.push({ sessionId, sessionFile, runtime: created });
        return created;
      },
    });
    await daemon.start();
    const request = (command, payload) => daemonRequest(endpoint, command, payload);
    return { agentDir, runtimes, hold, request };
  };

  const expectProviders = (response) => {
    expect(response.error).toBeUndefined();
    expect(response.ok).toBe(true);
    expect(response.result.providers.map((provider) => provider.id)).toEqual(['test']);
  };

  it('does not open a still live session a second time after the default session is deleted (#164)', async () => {
    const { agentDir, runtimes, request } = await setup();
    const project = join(tempRoot, 'project');
    await mkdir(project, { recursive: true });
    await writeSessionFile({ agentDir, cwd: project, sessionId: 'session-orchestrator' });
    await writeSessionFile({ agentDir, cwd: project, sessionId: 'session-worker' });

    // The worker becomes live first, then the orchestrator opens and stays
    // live. Reaching the live worker again (as session_stop does through the
    // interrupt path) makes it the default runtime.
    expect((await request('sessions.open', { sessionId: 'session-worker', directory: project })).ok).toBe(true);
    expect((await request('sessions.open', { sessionId: 'session-orchestrator', directory: project })).ok).toBe(true);
    expect((await request('sessions.open', { sessionId: 'session-worker', directory: project })).ok).toBe(true);
    expect((await request('sessions.delete', { sessionId: 'session-worker' })).ok).toBe(true);

    expectProviders(await request('providers.list', {}));
    // The live orchestrator runtime was never opened again.
    const orchestratorRuntimes = runtimes.filter((entry) => entry.sessionId === 'session-orchestrator');
    expect(orchestratorRuntimes).toHaveLength(1);
    expect(orchestratorRuntimes[0].runtime.disposed).toBe(false);
    // Repeated calls keep working without restarting the daemon.
    expectProviders(await request('providers.list', {}));
  });

  it('starts a runtime after the dormant default session is deleted (#171)', async () => {
    const { agentDir, request } = await setup();
    const project = join(tempRoot, 'project');
    await mkdir(project, { recursive: true });
    await writeSessionFile({ agentDir, cwd: project, sessionId: 'session-a' });

    expect((await request('sessions.open', { sessionId: 'session-a', directory: project })).ok).toBe(true);
    expect((await request('sessions.delete', { sessionId: 'session-a' })).ok).toBe(true);

    expectProviders(await request('providers.list', {}));
  });

  it('starts a runtime when the file of an idle dormant session is gone (#171)', async () => {
    const { agentDir, runtimes, request } = await setup({ idleTimeoutMs: 20 });
    const project = join(tempRoot, 'project');
    await mkdir(project, { recursive: true });
    const file = await writeSessionFile({ agentDir, cwd: project, sessionId: 'session-a' });

    expect((await request('sessions.open', { sessionId: 'session-a', directory: project })).ok).toBe(true);
    await waitFor(() => runtimes[0]?.runtime.disposed, { message: 'idle disposal did not run' });
    await rm(file);

    expectProviders(await request('providers.list', {}));
  });

  it('starts a runtime after worker cleanup removed the worktree and deleted the default session (#164)', async () => {
    const { agentDir, request } = await setup();
    const worktree = join(tempRoot, 'worktree');
    await mkdir(worktree, { recursive: true });
    await writeSessionFile({ agentDir, cwd: worktree, sessionId: 'session-worker' });

    // worker_cleanup removes the worktree first and deletes the session after.
    expect((await request('sessions.open', { sessionId: 'session-worker', directory: worktree })).ok).toBe(true);
    await rm(worktree, { recursive: true, force: true });
    expect((await request('sessions.delete', { sessionId: 'session-worker' })).ok).toBe(true);

    expectProviders(await request('providers.list', {}));
  });

  it('adopts the runtime that wins the race for the dormant session and disposes its own (#164)', async () => {
    const { agentDir, runtimes, hold, request } = await setup({ idleTimeoutMs: 300 });
    const project = join(tempRoot, 'project');
    await mkdir(project, { recursive: true });
    await writeSessionFile({ agentDir, cwd: project, sessionId: 'session-a' });
    expect((await request('sessions.open', { sessionId: 'session-a', directory: project })).ok).toBe(true);
    await waitFor(() => runtimes[0]?.runtime.disposed, { message: 'idle disposal did not run' });

    // The default runtime reopens session-a while the same session is opened
    // directly. The direct open registers first.
    hold.enabled = true;
    const providers = request('providers.list', {});
    await waitFor(() => hold.pending.length === 1, { message: 'default runtime start did not begin' });
    const opened = request('sessions.open', { sessionId: 'session-a', directory: project });
    await waitFor(() => hold.pending.length === 2, { message: 'session open did not begin' });
    hold.pending[1]();
    expect((await opened).ok).toBe(true);
    hold.pending[0]();

    expectProviders(await providers);
    const [winner, duplicate] = runtimes.slice(1);
    expect(runtimes).toHaveLength(3);
    expect(winner.runtime.disposed).toBe(false);
    expect(duplicate.runtime.disposed).toBe(true);
  });

  it('starts a runtime when the worktree of an idle dormant session is gone', async () => {
    const { agentDir, runtimes, request } = await setup({ idleTimeoutMs: 20 });
    const worktree = join(tempRoot, 'worktree');
    await mkdir(worktree, { recursive: true });
    await writeSessionFile({ agentDir, cwd: worktree, sessionId: 'session-kept' });

    // The session stays on disk for the owner; only its worktree is gone.
    expect((await request('sessions.open', { sessionId: 'session-kept', directory: worktree })).ok).toBe(true);
    await waitFor(() => runtimes[0]?.runtime.disposed, { message: 'idle disposal did not run' });
    await rm(worktree, { recursive: true, force: true });

    expectProviders(await request('providers.list', {}));
  });
});
