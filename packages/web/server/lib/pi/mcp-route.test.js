import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';

import { registerPiRuntimeRoutes } from './routes.js';
import {
  createOrchestrationCredentialStore,
  isOrchestrationMcpRequest,
} from '../client-auth/orchestration-credentials.js';
import { ORCHESTRATION_TOOL_NAMES } from './session-daemon/orchestration/tool-contracts.js';

const listen = (app) => new Promise((resolve, reject) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
  server.once('error', reject);
});

const close = (server) => new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));

const createRuntime = () => {
  const calls = [];
  // Sessions the daemon no longer has, e.g. removed by its idle cleanup.
  const gone = new Set(['never-existed']);
  return {
    calls,
    gone,
    request: async (command, payload) => {
      calls.push({ command, payload });
      if (command === 'sessions.delete') return { deleted: true };
      if (gone.has(payload.sessionId) && command.startsWith('orchestration.')) {
        return { error: { code: 'ORCHESTRATION_CALLER_GONE', message: 'The calling session no longer exists.' } };
      }
      if (command === 'orchestration.caller') return { value: { sessionId: payload.sessionId } };
      if (command !== 'orchestration.call') throw Object.assign(new Error('unexpected'), { code: 'UNSUPPORTED' });
      if (payload.tool === 'session_stop') {
        return { error: { code: 'ORCHESTRATION_NOT_DESCENDANT', message: 'Not your worker.' } };
      }
      return { value: { caller: payload.sessionId, tool: payload.tool, args: payload.args } };
    },
  };
};

describe('orchestration MCP route', () => {
  let server;
  afterEach(async () => {
    await close(server);
    server = undefined;
  });

  const start = async ({ now } = {}) => {
    let clock = 1_000_000;
    const store = createOrchestrationCredentialStore({ now: now ?? (() => clock), lifetimeMs: 60_000, idleMs: 10_000 });
    const runtime = createRuntime();
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime, orchestrationCredentialStore: store });
    server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const mint = async (sessionId) => {
      const response = await fetch(`${base}/api/pi/sessions/${sessionId}/orchestration-credential`, { method: 'POST' });
      expect(response.status).toBe(201);
      return response.json();
    };
    const rpc = (token, body) => fetch(`${base}/api/pi/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { base, store, runtime, mint, rpc, advance: (ms) => { clock += ms; } };
  };

  it('initializes, lists the tools and calls them as the credential session', async () => {
    const { mint, rpc, runtime } = await start();
    const { token, expiresAt } = await mint('parent-1');
    expect(token).toMatch(/^pcorch_/);
    expect(expiresAt).toBeGreaterThan(0);

    const init = await (await rpc(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).json();
    expect(init.result).toMatchObject({ protocolVersion: '2025-03-26', serverInfo: { name: 'pichamber' }, capabilities: { tools: {} } });

    const notified = await rpc(token, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notified.status).toBe(202);

    const list = await (await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    expect(list.result.tools.map((tool) => tool.name)).toEqual(ORCHESTRATION_TOOL_NAMES);
    expect(list.result.tools[0].inputSchema).toMatchObject({ type: 'object' });

    // A session id in the arguments or body cannot redirect the caller.
    const call = await (await rpc(token, {
      jsonrpc: '2.0', id: 3, method: 'tools/call', sessionId: 'other',
      params: { name: 'session_list', arguments: { sessionId: 'other' } },
    })).json();
    expect(call.result.isError).toBeUndefined();
    expect(JSON.parse(call.result.content[0].text)).toEqual({ caller: 'parent-1', tool: 'session_list', args: { sessionId: 'other' } });
    expect(runtime.calls.at(-1)).toEqual({ command: 'orchestration.call', payload: { sessionId: 'parent-1', tool: 'session_list', args: { sessionId: 'other' } } });
  });

  it('returns tool failures as error results and unknown methods as JSON-RPC errors', async () => {
    const { mint, rpc } = await start();
    const { token } = await mint('parent-1');
    const failed = await (await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_stop', arguments: { sessionId: 'x' } } })).json();
    expect(failed.result.isError).toBe(true);
    expect(JSON.parse(failed.result.content[0].text)).toMatchObject({ code: 'ORCHESTRATION_NOT_DESCENDANT' });
    const unknownTool = await (await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bash', arguments: {} } })).json();
    expect(unknownTool.result.isError).toBe(true);
    const unknownMethod = await (await rpc(token, { jsonrpc: '2.0', id: 3, method: 'resources/list' })).json();
    expect(unknownMethod.error.code).toBe(-32601);
  });

  it('rejects missing, unknown, expired, idle and revoked credentials', async () => {
    const { mint, rpc, advance, base } = await start();
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

    expect((await rpc(undefined, ping)).status).toBe(401);
    expect((await rpc('pcorch_forged', ping)).status).toBe(401);
    expect((await rpc('oc_client_something', ping)).status).toBe(401);

    const idle = await mint('idle-session');
    advance(10_001);
    expect((await rpc(idle.token, ping)).status).toBe(401);

    const expiring = await mint('expiring-session');
    for (let step = 0; step < 6; step += 1) {
      advance(9_000);
      expect((await rpc(expiring.token, ping)).status).toBe(200);
    }
    advance(9_000);
    expect((await rpc(expiring.token, ping)).status).toBe(401);

    const deleted = await mint('deleted-session');
    const kept = await mint('kept-session');
    expect((await fetch(`${base}/api/pi/sessions/deleted-session`, { method: 'DELETE' })).status).toBe(204);
    expect((await rpc(deleted.token, ping)).status).toBe(401);
    expect((await rpc(kept.token, ping)).status).toBe(200);
  });

  it('mints only for existing sessions and ends a credential whose session the daemon deleted on its own', async () => {
    const { mint, rpc, runtime, base } = await start();
    const unknown = await fetch(`${base}/api/pi/sessions/never-existed/orchestration-credential`, { method: 'POST' });
    expect(unknown.status).toBe(404);

    const removed = await mint('ephemeral');
    const kept = await mint('kept-session');
    // Idle cleanup inside the daemon: no HTTP DELETE reaches this server.
    runtime.gone.add('ephemeral');
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_read', arguments: { sessionId: 'kept-session' } } };
    const refused = await (await rpc(removed.token, call)).json();
    expect(refused.result.isError).toBe(true);
    expect(JSON.parse(refused.result.content[0].text)).toMatchObject({ code: 'ORCHESTRATION_CALLER_GONE' });
    expect((await rpc(removed.token, { jsonrpc: '2.0', id: 2, method: 'ping' })).status).toBe(401);

    const allowed = await (await rpc(kept.token, call)).json();
    expect(allowed.result.isError).toBeUndefined();
  });

  it('lets only POSTs to the MCP path with an orchestration bearer past the API gate', () => {
    const req = (method, token) => ({ method, headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect(isOrchestrationMcpRequest('/api/pi/mcp', req('POST', 'pcorch_abc'))).toBe(true);
    expect(isOrchestrationMcpRequest('/api/pi/mcp', req('GET', 'pcorch_abc'))).toBe(false);
    expect(isOrchestrationMcpRequest('/api/pi/mcp', req('POST', 'oc_client_abc'))).toBe(false);
    expect(isOrchestrationMcpRequest('/api/pi/mcp', req('POST'))).toBe(false);
    expect(isOrchestrationMcpRequest('/api/pi/sessions/x/orchestration-credential', req('POST', 'pcorch_abc'))).toBe(false);
    expect(isOrchestrationMcpRequest('/api/pi/settings', req('POST', 'pcorch_abc'))).toBe(false);
  });
});
