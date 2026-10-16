import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createSessionDaemon } from './session-daemon.js';
import { getPiSessionDirectory } from './session-jsonl.js';
import { readSessionLeaseOwner, resolveSessionLeaseFile } from './session-lease.js';

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
 * A session whose working directory is gone can still be aborted (#177).
 *
 * The fake runtime factory rejects a working directory that does not exist,
 * like the Pi SDK does ("Stored session working directory does not exist").
 * The daemon has a real identity, so session leases are taken for real.
 */

const credential = 'default-runtime-regression-secret';
const daemonId = 'default-runtime-daemon';

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
    this.disposeAttempts = (this.disposeAttempts ?? 0) + 1;
    if (this.failNextDispose) {
      this.failNextDispose = false;
      throw new Error('temporary shutdown failure');
    }
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
  let peer;

  afterEach(async () => {
    await peer?.stop().catch(() => {});
    peer = undefined;
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
      profileKey: 'default-runtime-profile',
      serverInstanceId: 'default-runtime-server',
      daemonId,
      createRuntime: async ({ cwd: runtimeCwd, sessionFile }) => {
        if (hold.enabled) await new Promise((resolve) => hold.pending.push(resolve));
        if (hold.failNextCreate) {
          hold.failNextCreate = false;
          throw new Error('Pi runtime start failed');
        }
        if (!existsSync(runtimeCwd)) throw new Error(`Stored session working directory does not exist: ${runtimeCwd}`);
        const sessionId = sessionFile
          ? JSON.parse(readFileSync(sessionFile, 'utf8').split('\n')[0]).id
          : `fresh-${freshSessions += 1}`;
        const created = new FakeRuntime({ cwd: runtimeCwd, session: new FakeSession(sessionId, sessionFile, runtimeCwd) });
        if (hold.failDisposeOfNext) {
          hold.failDisposeOfNext = false;
          created.failNextDispose = true;
        }
        runtimes.push({ sessionId, sessionFile, runtime: created });
        return created;
      },
    });
    await daemon.start();
    const request = (command, payload) => daemonRequest(endpoint, command, payload);
    return { agentDir, runtimes, hold, request };
  };

  // A second daemon with its own identity on the same agent directory, like
  // another PiChamber instance. It may open session-a only when the lease is
  // free.
  const startPeer = async ({ agentDir, project }) => {
    const peerRoot = join(tempRoot, 'peer');
    await mkdir(peerRoot, { recursive: true });
    const endpoint = testDaemonEndpoint(peerRoot);
    peer = createSessionDaemon({
      endpoint,
      credential,
      cwd: project,
      agentDir,
      profileKey: 'default-runtime-peer-profile',
      serverInstanceId: 'default-runtime-peer-server',
      daemonId: 'default-runtime-peer-daemon',
      createRuntime: async ({ cwd: runtimeCwd, sessionFile }) => new FakeRuntime({
        cwd: runtimeCwd,
        session: new FakeSession('session-a', sessionFile, runtimeCwd),
      }),
    });
    await peer.start();
    return () => daemonRequest(endpoint, 'sessions.open', { sessionId: 'session-a', directory: project });
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

  // Opens session-a and lets it go idle, so it is the dormant session. Then the
  // default runtime reopens it while the same session is opened directly. Both
  // runtime creates wait until the test releases them.
  const raceForDormantSession = async () => {
    const harness = await setup({ idleTimeoutMs: 300 });
    const { agentDir, runtimes, hold, request } = harness;
    const project = join(tempRoot, 'project');
    await mkdir(project, { recursive: true });
    await writeSessionFile({ agentDir, cwd: project, sessionId: 'session-a' });
    expect((await request('sessions.open', { sessionId: 'session-a', directory: project })).ok).toBe(true);
    // Idle disposal clears the default runtime only after it released the
    // lease, so wait until the lease and its lock are gone.
    const { file: leaseFile } = resolveSessionLeaseFile({ agentDir, cwd: project, sessionId: 'session-a' });
    await waitFor(
      () => runtimes[0]?.runtime.disposed && !existsSync(leaseFile) && !existsSync(`${leaseFile}.lock`),
      { message: 'idle disposal did not finish' },
    );

    hold.enabled = true;
    const providers = request('providers.list', {});
    await waitFor(() => hold.pending.length === 1, { message: 'default runtime start did not begin' });
    const opened = request('sessions.open', { sessionId: 'session-a', directory: project });
    await waitFor(() => hold.pending.length === 2, { message: 'session open did not begin' });
    const [startDefault, finishOpen] = hold.pending;
    const leaseOwner = () => readSessionLeaseOwner({ agentDir, cwd: project, sessionId: 'session-a' });
    return { ...harness, project, providers, opened, startDefault, finishOpen, leaseOwner };
  };

  it('adopts the runtime that wins the race for the dormant session and disposes its own (#164)', async () => {
    const { runtimes, providers, opened, startDefault, finishOpen, leaseOwner } = await raceForDormantSession();
    finishOpen();
    expect((await opened).ok).toBe(true);
    startDefault();

    expectProviders(await providers);
    const [winner, duplicate] = runtimes.slice(1);
    expect(runtimes).toHaveLength(3);
    expect(winner.runtime.disposed).toBe(false);
    expect(duplicate.runtime.disposed).toBe(true);
    expect(await leaseOwner()).toMatchObject({ daemonId });
  });

  it('keeps the lease of the runtime that won the race when the competing default start fails (#164)', async () => {
    const { runtimes, project, providers, opened, startDefault, finishOpen, leaseOwner } = await raceForDormantSession();
    finishOpen();
    expect((await opened).ok).toBe(true);
    // The removed directory makes the default start fail like the Pi SDK does.
    await rm(project, { recursive: true, force: true });
    startDefault();

    expect((await providers).ok).toBe(false);
    const [winner] = runtimes.slice(1);
    expect(runtimes).toHaveLength(2);
    expect(winner.runtime.disposed).toBe(false);
    expect(await leaseOwner()).toMatchObject({ daemonId });
  });

  it('keeps the lease while the same session is still opening when the default start fails', async () => {
    const { hold, providers, opened, startDefault, finishOpen, leaseOwner } = await raceForDormantSession();
    hold.failNextCreate = true;
    startDefault();

    expect((await providers).ok).toBe(false);
    expect(await leaseOwner()).toMatchObject({ daemonId });
    finishOpen();
    expect((await opened).ok).toBe(true);
    expect(await leaseOwner()).toMatchObject({ daemonId });
  });

  it('keeps a losing runtime whose disposal failed, so stop disposes it', async () => {
    const { runtimes, hold, providers, opened, startDefault, finishOpen, leaseOwner } = await raceForDormantSession();
    finishOpen();
    expect((await opened).ok).toBe(true);
    hold.failDisposeOfNext = true;
    startDefault();

    expectProviders(await providers);
    const [winner, duplicate] = runtimes.slice(1);
    expect(runtimes).toHaveLength(3);
    expect(winner.runtime.disposed).toBe(false);
    expect(duplicate.runtime.disposeAttempts).toBe(1);
    expect(await leaseOwner()).toMatchObject({ daemonId });

    await daemon.stop();
    expect(winner.runtime.disposed).toBe(true);
    expect(duplicate.runtime.disposed).toBe(true);
  });

  it('keeps the lease while a losing runtime is undisposed after the winner went idle', async () => {
    const { agentDir, project, runtimes, hold, providers, opened, startDefault, finishOpen, leaseOwner } = await raceForDormantSession();
    finishOpen();
    expect((await opened).ok).toBe(true);
    hold.failDisposeOfNext = true;
    startDefault();
    expectProviders(await providers);
    const [winner, duplicate] = runtimes.slice(1);
    const peerOpen = await startPeer({ agentDir, project });
    expect((await peerOpen()).error?.code).toBe('SESSION_IN_USE');

    await waitFor(() => winner.runtime.disposed, { message: 'winner idle disposal did not run' });
    // Nothing signals the end of idle disposal, so watch for a lease release
    // for a while instead.
    for (const deadline = Date.now() + 500; Date.now() < deadline && await leaseOwner();) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(duplicate.runtime.disposed).toBe(false);
    expect(await leaseOwner()).toMatchObject({ daemonId });
    expect((await peerOpen()).error?.code).toBe('SESSION_IN_USE');

    // Stop disposes the losing runtime, and only then the lease goes.
    await daemon.stop();
    expect(duplicate.runtime.disposed).toBe(true);
    expect(await leaseOwner()).toBeNull();
    expect((await peerOpen()).ok).toBe(true);
  });

  it('keeps the lease after stop while a losing runtime still fails to dispose', async () => {
    const { agentDir, project, runtimes, hold, providers, opened, startDefault, finishOpen, leaseOwner } = await raceForDormantSession();
    finishOpen();
    expect((await opened).ok).toBe(true);
    hold.failDisposeOfNext = true;
    startDefault();
    expectProviders(await providers);
    const [winner, duplicate] = runtimes.slice(1);
    const peerOpen = await startPeer({ agentDir, project });
    expect((await peerOpen()).error?.code).toBe('SESSION_IN_USE');

    duplicate.runtime.failNextDispose = true;
    await daemon.stop();
    expect(winner.runtime.disposed).toBe(true);
    expect(duplicate.runtime.disposed).toBe(false);
    expect(duplicate.runtime.disposeAttempts).toBe(2);
    expect(await leaseOwner()).toMatchObject({ daemonId });
    expect((await peerOpen()).error?.code).toBe('SESSION_IN_USE');
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

  // session_stop aborts a finished worker whose worktree was removed (#177).
  // This daemon never opened the session, as after a restart, so only the
  // stored directory in its file locates it.
  it('aborts a session whose working directory was removed without opening it (#177)', async () => {
    const { agentDir, request } = await setup();
    const worktree = join(tempRoot, 'removed-worktree');
    const file = await writeSessionFile({ agentDir, cwd: worktree, sessionId: 'session-no-dir' });

    expect(await request('sessions.abort', { sessionId: 'session-no-dir' })).toMatchObject({ ok: true });
    expect((await request('sessions.open', { sessionId: 'session-no-dir' })).error?.code).toBe('SESSION_DIRECTORY_MISSING');
    expect(await readSessionLeaseOwner({ agentDir, cwd: worktree, sessionId: 'session-no-dir' })).toBeNull();
    expect(existsSync(file)).toBe(true);
  });
});
