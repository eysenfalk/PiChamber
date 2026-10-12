/**
 * Adapter B of the orchestration tools: a minimal MCP Streamable HTTP endpoint
 * (JSON responses only, no SSE stream) at `POST /api/pi/mcp`.
 *
 * The caller is the session bound to the bearer credential; nothing in the
 * request body can choose another session. Tool calls are forwarded to the
 * daemon's `orchestration.call`, which owns every rule (limits, lineage,
 * permissions). Tool errors are MCP tool results with `isError`, so the model
 * sees the reason; only protocol problems become JSON-RPC errors.
 */

import { ORCHESTRATION_MCP_SERVER, ORCHESTRATION_TOOLS } from './session-daemon/orchestration/tool-contracts.js';
import { CALLER_GONE } from './session-daemon/orchestration/orchestration-service.js';
import { ORCHESTRATION_MCP_PATH, bearerTokenFrom } from '../client-auth/orchestration-credentials.js';

const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: ORCHESTRATION_MCP_SERVER, version: '1.0.0' };
const TOOL_NAMES = new Set(ORCHESTRATION_TOOLS.map((tool) => tool.name));
const MCP_TOOLS = ORCHESTRATION_TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.parameters,
}));

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const textResult = (value, isError = false) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

export const registerOrchestrationMcpRoute = (app, { getDaemonRuntime, credentialStore }) => {
  const callTool = async (sessionId, params) => {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (typeof name !== 'string' || !TOOL_NAMES.has(name)) {
      return textResult({ code: 'ORCHESTRATION_UNKNOWN_TOOL', message: `Unknown tool: ${String(name)}` }, true);
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return textResult({ code: 'INVALID_ARGUMENT', message: 'Tool arguments must be an object.' }, true);
    }
    try {
      const response = await getDaemonRuntime().request('orchestration.call', { sessionId, tool: name, args });
      if (response?.error) {
        // The daemon checks the bound session on every call, so a deletion
        // this server never saw (idle cleanup, a missed event) still ends
        // the credential on its next use.
        if (response.error.code === CALLER_GONE) credentialStore.revokeSession(sessionId);
        return textResult(response.error, true);
      }
      return textResult(response?.value ?? null);
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'DAEMON_REQUEST_FAILED';
      return textResult({ code, message: 'The PiChamber session daemon did not answer.' }, true);
    }
  };

  const handleMessage = async (sessionId, message) => {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcError(message?.id, -32600, 'Invalid request');
    }
    const isNotification = message.id === undefined || message.id === null;
    if (isNotification) return undefined;
    switch (message.method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion;
        const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
        return rpcResult(message.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });
      }
      case 'ping':
        return rpcResult(message.id, {});
      case 'tools/list':
        return rpcResult(message.id, { tools: MCP_TOOLS });
      case 'tools/call':
        return rpcResult(message.id, await callTool(sessionId, message.params));
      default:
        return rpcError(message.id, -32601, `Method not found: ${message.method}`);
    }
  };

  app.post(ORCHESTRATION_MCP_PATH, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const credential = credentialStore.authenticate(bearerTokenFrom(req));
    if (!credential) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json(rpcError(null, -32001, 'A valid PiChamber orchestration credential is required.'));
      return;
    }
    const body = req.body;
    if (body === undefined || body === null || typeof body !== 'object') {
      res.status(400).json(rpcError(null, -32700, 'Parse error'));
      return;
    }
    const messages = Array.isArray(body) ? body : [body];
    if (messages.length === 0) {
      res.status(400).json(rpcError(null, -32600, 'Invalid request'));
      return;
    }
    const responses = [];
    for (const message of messages) {
      const response = await handleMessage(credential.sessionId, message);
      if (response) responses.push(response);
    }
    if (responses.length === 0) {
      res.status(202).end();
      return;
    }
    res.json(Array.isArray(body) ? responses : responses[0]);
  });

  // Streamable HTTP clients may probe for a server-sent event stream; this server has none.
  app.get(ORCHESTRATION_MCP_PATH, (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).end();
  });
};
