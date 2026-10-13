import { createConnection } from 'node:net';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Shared by the orchestration tests that run the real daemon and Pi SDK.
export const credential = 'a-private-daemon-credential';

// pi-ai is a dependency of the pinned SDK, not of PiChamber; locate it next
// to (or inside) the SDK package the daemon actually loads.
export const piAiFauxUrl = () => {
  const sdkDir = realpathSync(fileURLToPath(new URL('../../../../../node_modules/@earendil-works/pi-coding-agent', import.meta.url)));
  const candidates = [join(dirname(sdkDir), 'pi-ai'), join(sdkDir, 'node_modules', '@earendil-works', 'pi-ai')];
  const piAiDir = candidates.find((candidate) => existsSync(join(candidate, 'dist', 'providers', 'faux.js')));
  if (!piAiDir) throw new Error('Pi faux provider not found next to the SDK.');
  return pathToFileURL(join(piAiDir, 'dist', 'providers', 'faux.js')).href;
};

// The tests run on a real host; its load or free memory must not refuse their spawns.
// `orchestration` adds further settings to the same file.
export function disableHostGate(dataDir, orchestration = {}) {
  mkdirSync(join(dataDir, 'pi'), { recursive: true });
  writeFileSync(join(dataDir, 'pi', 'settings.json'), JSON.stringify({ version: 1, orchestration: { ...orchestration, gate: { enabled: false } } }));
}

// Marks a session as orchestrator in the same file, as the UI switch does.
export function markOrchestrator(dataDir, sessionId) {
  const file = join(dataDir, 'pi', 'settings.json');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  settings.orchestration.orchestrators = { ...settings.orchestration.orchestrators, [sessionId]: true };
  writeFileSync(file, JSON.stringify(settings));
}

export function connectClient(endpoint) {
  const socket = createConnection({ path: endpoint });
  let buffer = '';
  const messages = [];
  const waiters = [];
  const publish = (message) => {
    messages.push(message);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (waiters[index].predicate(message)) waiters.splice(index, 1)[0].resolve(message);
    }
  };
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line) publish(JSON.parse(line));
    }
  });
  const next = (predicate, timeoutMs = 30_000) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for daemon message')), timeoutMs);
      waiters.push({ predicate, resolve: (message) => { clearTimeout(timer); resolve(message); } });
    });
  };
  return {
    async authenticate() {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(`${JSON.stringify({ kind: 'authenticate', credential })}\n`);
      await next((message) => message.kind === 'authenticated');
    },
    request(command, payload = {}) {
      const requestId = `request-${Math.random()}`;
      socket.write(`${JSON.stringify({ protocolVersion: 1, kind: 'request', requestId, command, payload })}\n`);
      return next((message) => (message.kind === 'response' && message.requestId === requestId) || message.kind === 'error');
    },
    next,
    events: messages,
    async close() {
      socket.end();
      await new Promise((resolve) => socket.once('close', resolve));
    },
  };
}
