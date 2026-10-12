/**
 * Session-scoped credentials for the orchestration MCP endpoint (`POST /api/pi/mcp`).
 *
 * A credential lets an MCP client act as exactly one Pi session. Only the
 * SHA-256 hash is kept, in memory: a server restart revokes every credential,
 * which matches the daemon-owned worker state it guards. Raw tokens are
 * returned once by `mint` and never logged or persisted.
 */

import crypto from 'node:crypto';

export const ORCHESTRATION_TOKEN_PREFIX = 'pcorch_';
export const ORCHESTRATION_PRINCIPAL_PREFIX = 'orch:';
export const DEFAULT_ORCHESTRATION_CREDENTIAL_LIFETIME_MS = 8 * 60 * 60 * 1000;
export const DEFAULT_ORCHESTRATION_CREDENTIAL_IDLE_MS = 30 * 60 * 1000;
const MAX_CREDENTIALS = 256;

const hashToken = (token) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');

/** Cheap shape check used by the global /api gate before the route verifies the token. */
export const isOrchestrationToken = (token) => typeof token === 'string'
  && token.startsWith(ORCHESTRATION_TOKEN_PREFIX)
  && token.length > ORCHESTRATION_TOKEN_PREFIX.length;

export const ORCHESTRATION_MCP_PATH = '/api/pi/mcp';

export const bearerTokenFrom = (req) => {
  const header = req?.headers?.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
};

/**
 * True for a POST to the MCP endpoint that carries an orchestration-shaped
 * bearer. The /api gate lets exactly these through; the route then verifies
 * the credential. Any other path with such a token still needs UI auth.
 */
export const isOrchestrationMcpRequest = (pathname, req) => req?.method === 'POST'
  && pathname === ORCHESTRATION_MCP_PATH
  && isOrchestrationToken(bearerTokenFrom(req));

export const createOrchestrationCredentialStore = ({
  now = () => Date.now(),
  lifetimeMs = DEFAULT_ORCHESTRATION_CREDENTIAL_LIFETIME_MS,
  idleMs = DEFAULT_ORCHESTRATION_CREDENTIAL_IDLE_MS,
  maxCredentials = MAX_CREDENTIALS,
} = {}) => {
  const records = new Map();

  const isLive = (record, at) => at < record.expiresAt && at - record.lastUsedAt < idleMs;

  const prune = (at) => {
    for (const [hash, record] of records) {
      if (!isLive(record, at)) records.delete(hash);
    }
  };

  const mint = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw Object.assign(new Error('A session id is required.'), { code: 'INVALID_ARGUMENT' });
    }
    const at = now();
    prune(at);
    // Bounded memory: the oldest credential gives way, it never blocks a mint.
    while (records.size >= maxCredentials) records.delete(records.keys().next().value);
    const token = `${ORCHESTRATION_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
    const expiresAt = at + lifetimeMs;
    records.set(hashToken(token), { sessionId, createdAt: at, lastUsedAt: at, expiresAt });
    return { token, sessionId, expiresAt, idleTimeoutMs: idleMs };
  };

  /** Resolve a raw token to its session, refreshing the idle timer; `null` when unknown, expired or revoked. */
  const authenticate = (token) => {
    if (!isOrchestrationToken(token)) return null;
    const hash = hashToken(token);
    const record = records.get(hash);
    if (!record) return null;
    const at = now();
    if (!isLive(record, at)) {
      records.delete(hash);
      return null;
    }
    record.lastUsedAt = at;
    return { sessionId: record.sessionId, principal: `${ORCHESTRATION_PRINCIPAL_PREFIX}${record.sessionId}` };
  };

  const revokeSession = (sessionId) => {
    let revoked = 0;
    for (const [hash, record] of records) {
      if (record.sessionId === sessionId) {
        records.delete(hash);
        revoked += 1;
      }
    }
    return revoked;
  };

  return { mint, authenticate, revokeSession };
};
