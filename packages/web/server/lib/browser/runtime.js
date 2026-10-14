import { WebSocketServer } from 'ws';

import { BROWSER_MAX_CLIENT_MESSAGE_BYTES, BROWSER_WS_PATH, parseBrowserClientMessage, parseRequestPathname } from './protocol.js';

const HEARTBEAT_MS = 30_000;
// Close code for a client whose place was taken by a newer connection.
const BROWSER_REPLACED_CLOSE_CODE = 4001;

/**
 * Remote browser route. The page itself renders in the desktop app; this
 * runtime only authenticates the socket, validates input and relays frames.
 * `remoteBrowserHost` is injected by the Electron shell and is null in every
 * other runtime, which then reports `desktop-app-required`.
 */
export function createBrowserRuntime({ app, server, uiAuthController, isRequestOriginAllowed, rejectWebSocketUpgrade, remoteBrowserHost = null, liveRevocation = null }) {
  app.get('/api/browser/status', (_req, res) => {
    res.json(remoteBrowserHost ? { available: true } : { available: false, reason: 'desktop-app-required' });
  });

  let active = null;
  let wsServer = new WebSocketServer({ noServer: true, maxPayload: BROWSER_MAX_CLIENT_MESSAGE_BYTES });
  wsServer.on('connection', (socket) => {
    // One viewer at a time: the newest connection takes over the page.
    if (active) active.close(BROWSER_REPLACED_CLOSE_CODE, 'replaced');
    active = socket;

    const emit = (message) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(message));
    };
    const session = remoteBrowserHost.attach({
      onFrame: (jpeg) => { if (socket.readyState === 1) socket.send(jpeg, { binary: true }); },
      onState: (state) => emit({ type: 'state', ...state }),
      onNotice: (notice) => emit({ type: 'notice', notice }),
    });
    const heartbeat = setInterval(() => { try { socket.ping(); } catch {} }, HEARTBEAT_MS);
    heartbeat.unref?.();

    socket.on('message', (raw, isBinary) => {
      try {
        if (isBinary) throw Object.assign(new Error('binary messages are not accepted'), { code: 'BAD_MESSAGE' });
        session.handle(parseBrowserClientMessage(raw));
      } catch (error) {
        emit({ type: 'error', code: error?.code || 'BROWSER_ERROR', message: error?.message || 'Invalid message' });
      }
    });
    socket.once('close', () => {
      clearInterval(heartbeat);
      if (active === socket) active = null;
      session.detach();
    });
    socket.on('error', () => {});
  });

  const trackUpgradePrincipal = (socket, principal, generation) => {
    if (!principal || typeof liveRevocation?.trackLiveConnection !== 'function') return null;
    let tracked;
    try {
      tracked = liveRevocation.trackLiveConnection({
        principal,
        close: () => { if (!socket.destroyed) socket.destroy(); },
        generation,
      });
    } catch {
      try { if (!socket.destroyed) socket.destroy(); } catch {}
      return { active: false, end: () => {}, revoke: () => false };
    }
    socket.once('close', () => tracked.end());
    return tracked;
  };

  const upgradeHandler = (req, socket, head) => {
    if (parseRequestPathname(req.url) !== BROWSER_WS_PATH) return;
    void (async () => {
      try {
        let principal = null;
        let generation;
        try {
          if (typeof liveRevocation?.getGeneration === 'function') generation = liveRevocation.getGeneration();
        } catch {
          generation = undefined;
        }
        if (uiAuthController?.enabled) {
          principal = await uiAuthController.ensureSessionToken(req, null);
          if (!principal) { rejectWebSocketUpgrade(socket, 401, 'UI authentication required'); return; }
          if (!await isRequestOriginAllowed(req)) { rejectWebSocketUpgrade(socket, 403, 'Invalid origin'); return; }
        }
        if (!remoteBrowserHost) { rejectWebSocketUpgrade(socket, 503, 'The remote browser requires the desktop app'); return; }
        if (!wsServer) { rejectWebSocketUpgrade(socket, 503, 'Browser WebSocket unavailable'); return; }
        const tracked = trackUpgradePrincipal(socket, principal, generation);
        if (principal && tracked && tracked.active === false) return;
        wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req));
      } catch { rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); }
    })();
  };
  server.on('upgrade', upgradeHandler);

  const shutdown = async () => {
    server.off('upgrade', upgradeHandler);
    if (!wsServer) return;
    for (const client of wsServer.clients) client.terminate();
    const current = wsServer;
    wsServer = null;
    await Promise.race([new Promise((resolve) => current.close(resolve)), new Promise((resolve) => setTimeout(resolve, 1000))]);
  };
  return { shutdown };
}
