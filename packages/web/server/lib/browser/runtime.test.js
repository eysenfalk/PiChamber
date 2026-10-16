import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { WebSocket } from 'ws';

import { parseBrowserClientMessage } from './protocol.js';

// The data dir must exist before ui-auth.js resolves its JWT secret path.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pichamber-browser-runtime-'));
process.env.PICHAMBER_DATA_DIR = dataDir;
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, label) => {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await wait(10);
  }
  throw new Error(`timed out waiting for ${label}`);
};

const createFakeHost = () => {
  const sessions = [];
  return {
    sessions,
    attach(listener) {
      const session = { listener, handled: [], detached: false };
      sessions.push(session);
      return {
        handle: (message) => session.handled.push(message),
        detach: () => { session.detached = true; },
      };
    },
  };
};

// Real ui-auth and origin gates on a real HTTP server, as in production.
const startServer = async ({ remoteBrowserHost = null, password = 'secret', timers } = {}) => {
  const { createUiAuth } = await import('../ui-auth/ui-auth.js');
  const { createRequestSecurityRuntime } = await import('../security/request-security.js');
  const { createBrowserRuntime } = await import('./runtime.js');
  const uiAuthController = createUiAuth({
    password,
    clientAuthController: {
      authenticateBearerToken: async (token) => token === 'client-token' ? { ok: true, clientId: 'device-1' } : null,
    },
  });
  const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
  const app = express();
  app.post('/auth/url-token', (req, res) => { void uiAuthController.handleUrlAuthToken(req, res); });
  const server = http.createServer(app);
  const runtime = createBrowserRuntime({
    app,
    server,
    uiAuthController,
    remoteBrowserHost,
    isRequestOriginAllowed: security.isRequestOriginAllowed,
    rejectWebSocketUpgrade: security.rejectWebSocketUpgrade,
    ...(timers ? { timers } : {}),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Without `bearer` this mints like the desktop UI without a UI password:
  // from the cookie session the server sets on that request.
  const mintToken = async ({ bearer = true } = {}) => {
    const response = await fetch(`${base}/auth/url-token`, {
      method: 'POST',
      headers: { ...(bearer ? { authorization: 'Bearer client-token' } : {}), accept: 'application/json' },
    });
    return (await response.json()).token;
  };
  const open = async ({ token, origin = base, autoPong = true } = {}) => {
    const query = token ? `?oc_url_token=${encodeURIComponent(token)}` : '';
    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/browser/ws${query}`, { headers: origin ? { origin } : {}, autoPong });
    socket.on('error', () => {});
    const messages = [];
    socket.on('message', (data, isBinary) => messages.push(isBinary ? { binary: Buffer.from(data) } : JSON.parse(String(data))));
    const outcome = await new Promise((resolve) => {
      socket.once('open', () => resolve({ status: 101 }));
      socket.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
      socket.once('error', () => resolve({ status: 0 }));
    });
    return { socket, messages, ...outcome };
  };
  const stop = async () => {
    await runtime.shutdown();
    uiAuthController.dispose?.();
    await new Promise((resolve) => server.close(resolve));
  };
  return { base, mintToken, open, stop };
};

describe('browser runtime', () => {
  it('reports that the remote browser needs the desktop app when no host is injected', async () => {
    const harness = await startServer();
    try {
      expect(await (await fetch(`${harness.base}/api/browser/status`)).json()).toEqual({ available: false, reason: 'desktop-app-required' });
      const { status } = await harness.open({ token: await harness.mintToken() });
      expect(status).toBe(503);
    } finally {
      await harness.stop();
    }
  });

  it('rejects sockets without UI auth or from another origin', async () => {
    const host = createFakeHost();
    const harness = await startServer({ remoteBrowserHost: host });
    try {
      expect(await (await fetch(`${harness.base}/api/browser/status`)).json()).toEqual({ available: true });
      expect((await harness.open()).status).toBe(401);
      expect((await harness.open({ token: 'oc_url_forged' })).status).toBe(401);
      expect((await harness.open({ token: await harness.mintToken(), origin: 'https://evil.example' })).status).toBe(403);
      expect(host.sessions).toHaveLength(0);
    } finally {
      await harness.stop();
    }
  });

  it('keeps auth and origin checks on a desktop without a UI password', async () => {
    const host = createFakeHost();
    const harness = await startServer({ remoteBrowserHost: host, password: '' });
    try {
      // No credential, even from the own UI origin.
      expect((await harness.open()).status).toBe(401);
      expect((await harness.open({ token: 'oc_url_forged' })).status).toBe(401);
      // A page in any other browser tab on the laptop: valid token or not, its origin is foreign.
      const token = await harness.mintToken({ bearer: false });
      expect((await harness.open({ token, origin: 'https://evil.example' })).status).toBe(403);
      expect((await harness.open({ token, origin: 'http://localhost:1' })).status).toBe(403);
      expect((await harness.open({ token: await harness.mintToken({ bearer: false }), origin: null })).status).toBe(403);
      expect(host.sessions).toHaveLength(0);

      // The own UI: URL token minted from its session, and a paired client credential.
      const own = await harness.open({ token: await harness.mintToken({ bearer: false }) });
      expect(own.status).toBe(101);
      const paired = await harness.open({ token: await harness.mintToken() });
      expect(paired.status).toBe(101);
      paired.socket.close();
      await until(() => host.sessions.length === 2, 'attach');
    } finally {
      await harness.stop();
    }
  });

  it('terminates a client that stops answering heartbeats and detaches it', async () => {
    const ticks = [];
    const timers = { setInterval: (callback) => { ticks.push(callback); return ticks.length; }, clearInterval: () => {} };
    const host = createFakeHost();
    const harness = await startServer({ remoteBrowserHost: host, timers });
    try {
      // A client that answers survives any number of beats.
      const answering = await harness.open({ token: await harness.mintToken() });
      await until(() => ticks.length === 1, 'heartbeat 1');
      for (let i = 0; i < 3; i += 1) {
        ticks[0]();
        await wait(50);
      }
      expect(answering.socket.readyState).toBe(WebSocket.OPEN);
      expect(host.sessions[0].detached).toBe(false);
      answering.socket.close();
      await until(() => host.sessions[0].detached, 'answering detach');

      // A silent client: the first beat pings, the next one terminates it,
      // and the normal close path detaches the viewer from the host.
      const silent = await harness.open({ token: await harness.mintToken(), autoPong: false });
      await until(() => ticks.length === 2 && host.sessions.length === 2, 'heartbeat 2');
      const silentClosed = new Promise((resolve) => silent.socket.once('close', (code) => resolve(code)));
      ticks[1]();
      await wait(50);
      expect(host.sessions[1].detached).toBe(false);
      ticks[1]();
      expect(await silentClosed).toBe(1006);
      await until(() => host.sessions[1].detached, 'silent detach');
    } finally {
      await harness.stop();
    }
  });

  it('relays frames and state to the client and validated input to the host', async () => {
    const host = createFakeHost();
    const harness = await startServer({ remoteBrowserHost: host });
    try {
      const client = await harness.open({ token: await harness.mintToken() });
      expect(client.status).toBe(101);
      await until(() => host.sessions.length === 1, 'attach');
      const [session] = host.sessions;

      session.listener.onFrame(Buffer.from([0xff, 0xd8, 0xff]));
      session.listener.onState({ url: 'http://10.0.0.5/', title: 'Intranet', canGoBack: false, canGoForward: false, loading: false });
      session.listener.onNotice('download-blocked');
      await until(() => client.messages.length === 3, 'server messages');
      expect(client.messages[0].binary).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect(client.messages[1]).toEqual({ type: 'state', url: 'http://10.0.0.5/', title: 'Intranet', canGoBack: false, canGoForward: false, loading: false });
      expect(client.messages[2]).toEqual({ type: 'notice', notice: 'download-blocked' });

      client.socket.send(JSON.stringify({ type: 'navigate', url: 'http://10.0.0.5/login' }));
      client.socket.send(JSON.stringify({ type: 'tap', x: 10.4, y: 20 }));
      client.socket.send(JSON.stringify({ type: 'navigate', url: 'file:///etc/passwd' }));
      client.socket.send(Buffer.from([1, 2, 3]));
      await until(() => session.handled.length === 2 && client.messages.length === 5, 'input');
      expect(session.handled).toEqual([
        { type: 'navigate', url: 'http://10.0.0.5/login' },
        { type: 'tap', x: 10, y: 20 },
      ]);
      expect(client.messages.slice(3).map((message) => message.code)).toEqual(['BAD_MESSAGE', 'BAD_MESSAGE']);

      client.socket.close();
      await until(() => session.detached, 'detach');
    } finally {
      await harness.stop();
    }
  });

  it('closes a client that sends an oversized message', async () => {
    const host = createFakeHost();
    const harness = await startServer({ remoteBrowserHost: host });
    try {
      const client = await harness.open({ token: await harness.mintToken() });
      const closed = new Promise((resolve) => client.socket.once('close', (code) => resolve(code)));
      client.socket.send(JSON.stringify({ type: 'text', text: 'x'.repeat(20_000) }));
      expect(await closed).toBe(1009);
      await until(() => host.sessions[0]?.detached, 'detach');
      expect(host.sessions[0].handled).toEqual([]);
    } finally {
      await harness.stop();
    }
  });

  it('hands the page to the newest client and closes the previous one', async () => {
    const host = createFakeHost();
    const harness = await startServer({ remoteBrowserHost: host });
    try {
      const first = await harness.open({ token: await harness.mintToken() });
      const firstClosed = new Promise((resolve) => first.socket.once('close', (code) => resolve(code)));
      const second = await harness.open({ token: await harness.mintToken() });
      expect(second.status).toBe(101);
      expect(await firstClosed).toBe(4001);
      await until(() => host.sessions.length === 2 && host.sessions[0].detached, 'first detach');
      expect(host.sessions[1].detached).toBe(false);
      second.socket.close();
    } finally {
      await harness.stop();
    }
  });
});

describe('browser client messages', () => {
  it('accepts every supported message in normalized form', () => {
    expect(parseBrowserClientMessage('{"type":"back"}')).toEqual({ type: 'back' });
    expect(parseBrowserClientMessage('{"type":"resize","width":390.2,"height":844}')).toEqual({ type: 'resize', width: 390, height: 844 });
    expect(parseBrowserClientMessage('{"type":"scroll","x":1,"y":2,"deltaY":300}')).toEqual({ type: 'scroll', x: 1, y: 2, deltaX: 0, deltaY: 300 });
    expect(parseBrowserClientMessage('{"type":"text","text":"hello"}')).toEqual({ type: 'text', text: 'hello' });
    expect(parseBrowserClientMessage('{"type":"key","key":"Enter"}')).toEqual({ type: 'key', key: 'Enter' });
  });

  it('rejects malformed, unknown and out of range messages', () => {
    for (const raw of [
      'not json',
      '{}',
      '{"type":"eval","code":"1"}',
      '{"type":"navigate","url":"javascript:alert(1)"}',
      '{"type":"navigate","url":"pichamber-ui://app/"}',
      '{"type":"resize","width":10,"height":844}',
      '{"type":"tap","x":-1,"y":0}',
      '{"type":"tap","x":"1","y":0}',
      '{"type":"key","key":"F12"}',
      '{"type":"text","text":""}',
    ]) {
      expect(() => parseBrowserClientMessage(raw)).toThrow();
    }
  });
});
