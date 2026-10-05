import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createClientPairingRuntime } from '../client-auth/pairing.js';
import { createRemoteClientAuthRuntime } from '../client-auth/remote-clients.js';
import { registerAuthAndAccessRoutes } from '../server/core-routes.js';
import { createTunnelAuth } from '../server/tunnel-auth.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createHostRestart } from './host-restart.js';
import { registerPiRuntimeRoutes } from './routes.js';

const listen = (app) => new Promise((resolve, reject) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
  server.once('error', reject);
});

const close = (server) => new Promise((resolve) => {
  if (!server) return resolve();
  server.closeAllConnections?.();
  server.close(() => resolve());
});

const post = (server, route, init = {}) => fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: 'POST', ...init });

describe('POST /api/pi/runtime/reload', () => {
  let server;
  afterEach(async () => {
    await close(server);
    server = undefined;
  });

  const start = async (runtime, extra = {}) => {
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime, ...extra });
    server = await listen(app);
  };

  it('forwards to the daemon and returns only the counts', async () => {
    const request = vi.fn(async () => ({ reloaded: 2, deferred: 1, failed: 0, endpoint: '/private/socket' }));
    await start({ request });
    const response = await post(server, '/api/pi/runtime/reload');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ reloaded: 2, deferred: 1, failed: 0 });
    expect(request).toHaveBeenCalledWith('runtime.reloadResources');
  });

  it('reports an unavailable daemon as 503 and a malformed reply as a protocol mismatch', async () => {
    await start(null);
    expect((await post(server, '/api/pi/runtime/reload')).status).toBe(503);
    await close(server);

    await start({ request: async () => ({ reloaded: 'two' }) });
    const mismatch = await post(server, '/api/pi/runtime/reload');
    expect(mismatch.status).toBe(503);
    await expect(mismatch.json()).resolves.toEqual({ error: { code: 'DAEMON_PROTOCOL_MISMATCH' } });
  });
});

describe('POST /api/pi/runtime/restart', () => {
  let server;
  afterEach(async () => {
    await close(server);
    server = undefined;
  });

  const start = async (restartHost, extra = {}) => {
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, {
      getPiSessionDaemonRuntime: () => null,
      restartHost,
      logRestartFailure: () => {},
      ...extra,
    });
    server = await listen(app);
  };

  it('answers 501 when the host cannot restart', async () => {
    await start(null);
    const response = await post(server, '/api/pi/runtime/restart');
    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({ error: { code: 'RESTART_UNSUPPORTED' } });
  });

  it('answers 202 and ends the process only after the prepare phase and the reply', async () => {
    const order = [];
    const commit = vi.fn(() => { order.push('commit'); });
    await start(async () => {
      order.push('prepare');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(commit).not.toHaveBeenCalled();
      return { scope: 'process', commit };
    });
    const response = await post(server, '/api/pi/runtime/restart');
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true, scope: 'process' });
    await expect.poll(() => commit.mock.calls.length).toBe(1);
    expect(order).toEqual(['prepare', 'commit']);
  });

  it('reports a daemon-only restart without ending the process', async () => {
    const commit = vi.fn();
    await start(async () => ({ scope: 'daemon', commit }));
    const response = await post(server, '/api/pi/runtime/restart');
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true, scope: 'daemon' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(commit).not.toHaveBeenCalled();
  });

  it('shows the failure of a failing hook, keeps the server usable and allows a retry', async () => {
    const commit = vi.fn();
    const restartHost = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'DAEMON_STOP_TIMEOUT' }))
      .mockResolvedValueOnce({ scope: 'process', commit });
    const request = vi.fn(async () => ({ reloaded: 1, deferred: 0, failed: 0 }));
    await start(restartHost, { getPiSessionDaemonRuntime: () => ({ request }) });

    const failed = await post(server, '/api/pi/runtime/restart');
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({
      error: { code: 'RESTART_FAILED', message: 'The restart failed (DAEMON_STOP_TIMEOUT).' },
    });
    expect(commit).not.toHaveBeenCalled();

    // The server still answers other requests and accepts a second attempt.
    expect((await post(server, '/api/pi/runtime/reload')).status).toBe(200);
    expect((await post(server, '/api/pi/runtime/restart')).status).toBe(202);
    await expect.poll(() => commit.mock.calls.length).toBe(1);
  });

  it('rejects a second restart while one is in flight', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await start(async () => {
      await gate;
      return { scope: 'daemon' };
    });
    const first = post(server, '/api/pi/runtime/restart');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await post(server, '/api/pi/runtime/restart');
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(202);
  });
});

describe('runtime reload and restart authentication', () => {
  let server;
  let dataDir;
  afterEach(async () => {
    await close(server);
    server = undefined;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  const start = async ({ restartHost, request }) => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pichamber-runtime-auth-'));
    const remoteClientAuthRuntime = createRemoteClientAuthRuntime({
      fsPromises: fs.promises, path, crypto, storePath: path.join(dataDir, 'remote-clients.json'),
    });
    const clientPairingRuntime = createClientPairingRuntime({
      fsPromises: fs.promises, path, crypto, storePath: path.join(dataDir, 'pairing.json'), remoteClientAuthRuntime,
    });
    const tunnelAuthController = createTunnelAuth();
    const uiAuthController = createUiAuth({
      password: 'correct horse',
      readSettingsFromDiskMigrated: async () => ({}),
      clientAuthController: remoteClientAuthRuntime,
    });
    const app = express();
    app.use(express.json());
    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController,
      uiAuthController,
      remoteClientAuthRuntime,
      clientPairingRuntime,
      readSettingsFromDiskMigrated: async () => ({}),
      normalizeTunnelSessionTtlMs: () => 8 * 60 * 60 * 1000,
    });
    registerPiRuntimeRoutes(app, {
      getPiSessionDaemonRuntime: () => ({ request }),
      restartHost,
      logRestartFailure: () => {},
    });
    server = await listen(app);
    return uiAuthController;
  };

  it('rejects unauthenticated calls to both routes without running either action', async () => {
    const request = vi.fn(async () => ({ reloaded: 0, deferred: 0, failed: 0 }));
    const restartHost = vi.fn(async () => ({ scope: 'daemon' }));
    await start({ restartHost, request });

    for (const route of ['/api/pi/runtime/reload', '/api/pi/runtime/restart']) {
      const response = await post(server, route);
      expect(response.status).toBe(401);
    }
    expect(request).not.toHaveBeenCalled();
    expect(restartHost).not.toHaveBeenCalled();
  });

  it('runs both actions for a session authenticated through the normal UI login', async () => {
    const request = vi.fn(async () => ({ reloaded: 3, deferred: 0, failed: 0 }));
    const restartHost = vi.fn(async () => ({ scope: 'daemon' }));
    await start({ restartHost, request });

    const login = await post(server, '/auth/session', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'correct horse' }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(';')[0]).join('; ');
    expect(cookie).not.toBe('');

    const reload = await post(server, '/api/pi/runtime/reload', { headers: { Cookie: cookie } });
    expect(reload.status).toBe(200);
    const restart = await post(server, '/api/pi/runtime/restart', { headers: { Cookie: cookie } });
    expect(restart.status).toBe(202);
    expect(restartHost).toHaveBeenCalledTimes(1);
  });
});

describe('createHostRestart', () => {
  const supervisorWith = (overrides = {}) => ({
    stop: vi.fn(async () => ({ state: 'stopped' })),
    start: vi.fn(async () => ({ state: 'ready' })),
    ...overrides,
  });

  it('restarts only the daemon when nothing can bring the server back', async () => {
    const supervisor = supervisorWith();
    const restart = createHostRestart({ getSupervisor: () => supervisor, env: {}, exitProcess: vi.fn() });
    const outcome = await restart();
    expect(outcome).toEqual({ scope: 'daemon' });
    expect(supervisor.stop).toHaveBeenCalledTimes(1);
    expect(supervisor.start).toHaveBeenCalledTimes(1);
  });

  it('stops the daemon and exits under a process manager (systemd INVOCATION_ID)', async () => {
    const supervisor = supervisorWith();
    const exitProcess = vi.fn();
    const restart = createHostRestart({ getSupervisor: () => supervisor, env: { INVOCATION_ID: 'abc' }, exitProcess });
    const outcome = await restart();
    expect(outcome.scope).toBe('process');
    expect(supervisor.stop).toHaveBeenCalledTimes(1);
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
    outcome.commit();
    expect(exitProcess).toHaveBeenCalledTimes(1);
  });

  it('arms a host relaunch after stopping the daemon and leaves the exit to commit', async () => {
    const order = [];
    const supervisor = supervisorWith({ stop: vi.fn(async () => { order.push('stop'); }) });
    const restartProcess = { prepare: vi.fn(() => { order.push('prepare'); }), commit: vi.fn() };
    const restart = createHostRestart({ getSupervisor: () => supervisor, restartProcess, env: {}, exitProcess: vi.fn() });
    const outcome = await restart();
    expect(order).toEqual(['stop', 'prepare']);
    expect(outcome).toEqual({ scope: 'process', commit: restartProcess.commit });
    expect(restartProcess.commit).not.toHaveBeenCalled();
  });

  it('starts the daemon again and rethrows when the daemon does not stop', async () => {
    const error = Object.assign(new Error('timeout'), { code: 'DAEMON_STOP_TIMEOUT' });
    const supervisor = supervisorWith({ stop: vi.fn(async () => { throw error; }) });
    const restart = createHostRestart({
      getSupervisor: () => supervisor,
      restartProcess: { prepare: vi.fn(), commit: vi.fn() },
      env: {},
    });
    await expect(restart()).rejects.toBe(error);
    expect(supervisor.start).toHaveBeenCalledTimes(1);
  });

  it('starts the daemon again and rethrows when the relaunch cannot be armed', async () => {
    const error = new Error('relaunch failed');
    const supervisor = supervisorWith();
    const restartProcess = { prepare: vi.fn(() => { throw error; }), commit: vi.fn() };
    const restart = createHostRestart({ getSupervisor: () => supervisor, restartProcess, env: {} });
    await expect(restart()).rejects.toBe(error);
    expect(supervisor.stop).toHaveBeenCalledTimes(1);
    expect(supervisor.start).toHaveBeenCalledTimes(1);
    expect(restartProcess.commit).not.toHaveBeenCalled();
  });

  it('treats an already-gone daemon as stopped and still starts a fresh one', async () => {
    const gone = Object.assign(new Error('gone'), { code: 'DAEMON_UNAVAILABLE' });
    const supervisor = supervisorWith({ stop: vi.fn(async () => { throw gone; }) });
    const restart = createHostRestart({ getSupervisor: () => supervisor, env: {} });
    await expect(restart()).resolves.toEqual({ scope: 'daemon' });
    expect(supervisor.start).toHaveBeenCalledTimes(1);
  });

  it('reports an unavailable supervisor', async () => {
    const restart = createHostRestart({ getSupervisor: () => null, env: {} });
    await expect(restart()).rejects.toMatchObject({ code: 'DAEMON_UNAVAILABLE' });
  });
});
