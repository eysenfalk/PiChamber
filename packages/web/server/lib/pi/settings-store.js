import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { resolvePiChamberDataDir } from '../pichamber-data-dir.js';
import { withCrossProcessLock } from '../server/cross-process-lock.js';
import { isPiThinkingLevel } from './thinking-levels.js';

const invalidSettings = () => {
  const error = new Error('PiChamber Pi settings are invalid.');
  error.code = 'PI_SETTINGS_INVALID';
  return error;
};

const normalizeModel = (value) => {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || typeof value.providerId !== 'string' || typeof value.modelId !== 'string'
    || value.providerId.trim().length === 0 || value.modelId.trim().length === 0
    || value.providerId.length > 256 || value.modelId.length > 512) {
    throw invalidSettings();
  }
  return { providerId: value.providerId.trim(), modelId: value.modelId.trim() };
};

const parseThinkingModelKey = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 768) return undefined;
  const separator = value.indexOf('/');
  if (separator <= 0 || separator >= value.length - 1) return undefined;
  const providerId = value.slice(0, separator).trim();
  const modelId = value.slice(separator + 1).trim();
  if (!providerId || !modelId || providerId.length > 256 || modelId.length > 512) return undefined;
  return `${providerId}/${modelId}`;
};

const normalizeThinkingByModel = (value) => {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidSettings();
  const entries = Object.entries(value);
  if (entries.length > 256) throw invalidSettings();
  const result = {};
  for (const [rawKey, level] of entries) {
    if (level === null || level === '') continue;
    const key = parseThinkingModelKey(rawKey);
    if (!key || !isPiThinkingLevel(level)) throw invalidSettings();
    result[key] = level;
  }
  return result;
};

const mergeThinkingByModel = (current, incoming) => {
  if (incoming === null) return {};
  if (incoming === undefined) return { ...current };
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw invalidSettings();
  const next = { ...current };
  for (const [rawKey, level] of Object.entries(incoming)) {
    const key = parseThinkingModelKey(rawKey);
    if (!key) throw invalidSettings();
    if (level === null || level === '') {
      delete next[key];
      continue;
    }
    if (!isPiThinkingLevel(level)) throw invalidSettings();
    next[key] = level;
  }
  return next;
};

const DEFAULT_RETRY_LIMIT = 3;
const MIN_RETRY_LIMIT = 0;
const MAX_RETRY_LIMIT = 10;

const normalizeRetryLimit = (value) => {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < MIN_RETRY_LIMIT || value > MAX_RETRY_LIMIT) throw invalidSettings();
  return value;
};

export const ORCHESTRATION_ROLES = Object.freeze(['orchestrate', 'plan', 'oracle', 'debug', 'task-easy', 'task-medium', 'task-hard', 'task-extreme', 'research', 'small', 'review']);
const ORCHESTRATION_MIN_WORKER_LIMIT = 1;
const ORCHESTRATION_MAX_WORKER_LIMIT = 16;
// Bounds of the wake and watchdog settings (O16).
const ORCHESTRATION_BOUNDS = Object.freeze({
  coalesceMs: [0, 60_000],
  stallAfterMs: [60_000, 7_200_000],
});
const ORCHESTRATION_MAX_GATE_BYTES = 1024 ** 4;

// Role defaults name only the model id: the provider that serves it is resolved
// against the live catalog when a worker starts, so a default never pins a
// provider the owner has not configured. The values are the owner's (2026-10-12);
// Claude 5.5 models always think, so no default uses `off`.
export const DEFAULT_ORCHESTRATION_SETTINGS = Object.freeze({
  workerLimit: 4,
  wakes: Object.freeze({ coalesceMs: 3_000 }),
  watchdog: Object.freeze({ stallAfterMs: 600_000, enabled: true }),
  // Watching the pull requests of workers (#119).
  github: Object.freeze({ enabled: true }),
  // A spawn is refused while the host is busy: load above the core count or less memory available than this.
  gate: Object.freeze({ enabled: true, minAvailableBytes: 8 * 1024 ** 3 }),
  roles: Object.freeze({
    orchestrate: Object.freeze({ modelId: 'claude-opus-5-5', thinking: 'high' }),
    plan: Object.freeze({ modelId: 'claude-opus-5-5', thinking: 'high' }),
    oracle: Object.freeze({ modelId: 'gpt-6.1-sol', thinking: 'high' }),
    debug: Object.freeze({ modelId: 'claude-opus-5-5', thinking: 'xhigh' }),
    'task-easy': Object.freeze({ modelId: 'claude-sonnet-5-5', thinking: 'medium' }),
    'task-medium': Object.freeze({ modelId: 'claude-sonnet-5-5', thinking: 'high' }),
    'task-hard': Object.freeze({ modelId: 'claude-opus-5-5', thinking: 'high' }),
    'task-extreme': Object.freeze({ modelId: 'claude-opus-5-5', thinking: 'xhigh' }),
    research: Object.freeze({ modelId: 'claude-sonnet-5-5', thinking: 'medium' }),
    small: Object.freeze({ modelId: 'claude-haiku-5-5', thinking: 'medium' }),
    review: Object.freeze({ modelId: 'gpt-6.1-sol', thinking: 'high' }),
  }),
});

const normalizeRole = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidSettings();
  if (typeof value.modelId !== 'string' || value.modelId.trim().length === 0 || value.modelId.length > 512) throw invalidSettings();
  if (value.providerId !== undefined && value.providerId !== null
    && (typeof value.providerId !== 'string' || value.providerId.trim().length === 0 || value.providerId.length > 256)) {
    throw invalidSettings();
  }
  if (value.thinking !== undefined && value.thinking !== null && !isPiThinkingLevel(value.thinking)) throw invalidSettings();
  return {
    ...(typeof value.providerId === 'string' ? { providerId: value.providerId.trim() } : {}),
    modelId: value.modelId.trim(),
    ...(typeof value.thinking === 'string' ? { thinking: value.thinking } : {}),
  };
};

// A settings group such as `wakes`: each field is a bounded duration or a flag.
const normalizeGroup = (value, fields) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalidSettings();
  const result = {};
  for (const [field, type] of Object.entries(fields)) {
    const entry = value[field];
    if (entry === undefined || entry === null) continue;
    if (type === 'boolean' ? typeof entry !== 'boolean' : !Number.isInteger(entry)
      || entry < ORCHESTRATION_BOUNDS[field][0] || entry > ORCHESTRATION_BOUNDS[field][1]) throw invalidSettings();
    result[field] = entry;
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

const normalizeOrchestration = (value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalidSettings();
  const result = {};
  if (value.workerLimit !== undefined && value.workerLimit !== null) {
    if (!Number.isInteger(value.workerLimit)
      || value.workerLimit < ORCHESTRATION_MIN_WORKER_LIMIT
      || value.workerLimit > ORCHESTRATION_MAX_WORKER_LIMIT) throw invalidSettings();
    result.workerLimit = value.workerLimit;
  }
  const wakes = normalizeGroup(value.wakes, { coalesceMs: 'ms' });
  if (wakes) result.wakes = wakes;
  const watchdog = normalizeGroup(value.watchdog, { stallAfterMs: 'ms', enabled: 'boolean' });
  if (watchdog) result.watchdog = watchdog;
  const github = normalizeGroup(value.github, { enabled: 'boolean' });
  if (github) result.github = github;
  if (value.gate !== undefined && value.gate !== null) {
    if (typeof value.gate !== 'object' || Array.isArray(value.gate)) throw invalidSettings();
    const gate = {};
    if (value.gate.enabled !== undefined && value.gate.enabled !== null) {
      if (typeof value.gate.enabled !== 'boolean') throw invalidSettings();
      gate.enabled = value.gate.enabled;
    }
    if (value.gate.minAvailableBytes !== undefined && value.gate.minAvailableBytes !== null) {
      if (!Number.isInteger(value.gate.minAvailableBytes)
        || value.gate.minAvailableBytes < 0
        || value.gate.minAvailableBytes > ORCHESTRATION_MAX_GATE_BYTES) throw invalidSettings();
      gate.minAvailableBytes = value.gate.minAvailableBytes;
    }
    if (Object.keys(gate).length > 0) result.gate = gate;
  }
  if (value.roles !== undefined && value.roles !== null) {
    if (typeof value.roles !== 'object' || Array.isArray(value.roles)) throw invalidSettings();
    const roles = {};
    for (const [role, entry] of Object.entries(value.roles)) {
      if (!ORCHESTRATION_ROLES.includes(role)) throw invalidSettings();
      if (entry === null) continue;
      roles[role] = normalizeRole(entry);
    }
    if (Object.keys(roles).length > 0) result.roles = roles;
  }
  if (value.worktreeRoot !== undefined && value.worktreeRoot !== null) {
    if (typeof value.worktreeRoot !== 'string' || !isAbsolute(value.worktreeRoot) || value.worktreeRoot.length > 4096) throw invalidSettings();
    result.worktreeRoot = value.worktreeRoot;
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

// Patch semantics: `null` clears every override, a role set to `null` returns
// that role to its default, and omitted fields keep their stored value.
const mergeOrchestration = (current, incoming) => {
  if (incoming === null) return undefined;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw invalidSettings();
  const next = { ...(current ?? {}) };
  if (Object.hasOwn(incoming, 'workerLimit')) next.workerLimit = incoming.workerLimit;
  for (const group of ['wakes', 'watchdog', 'github']) {
    if (!Object.hasOwn(incoming, group)) continue;
    const value = incoming[group];
    if (value === null) delete next[group];
    else if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidSettings();
    else next[group] = { ...(current?.[group] ?? {}), ...value };
  }
  if (Object.hasOwn(incoming, 'gate')) {
    if (incoming.gate === null) {
      delete next.gate;
    } else {
      if (!incoming.gate || typeof incoming.gate !== 'object' || Array.isArray(incoming.gate)) throw invalidSettings();
      next.gate = { ...(current?.gate ?? {}), ...incoming.gate };
    }
  }
  if (Object.hasOwn(incoming, 'worktreeRoot')) next.worktreeRoot = incoming.worktreeRoot;
  if (Object.hasOwn(incoming, 'roles')) {
    if (incoming.roles === null) {
      delete next.roles;
    } else {
      if (!incoming.roles || typeof incoming.roles !== 'object' || Array.isArray(incoming.roles)) throw invalidSettings();
      next.roles = { ...(current?.roles ?? {}), ...incoming.roles };
    }
  }
  return next;
};

/** Stored overrides merged over the defaults; the shape every consumer reads. */
export const resolveOrchestrationSettings = (stored) => {
  const overrides = stored?.orchestration ?? {};
  const roles = {};
  for (const role of ORCHESTRATION_ROLES) {
    roles[role] = { ...DEFAULT_ORCHESTRATION_SETTINGS.roles[role], ...(overrides.roles?.[role] ?? {}) };
  }
  return {
    workerLimit: overrides.workerLimit ?? DEFAULT_ORCHESTRATION_SETTINGS.workerLimit,
    wakes: { ...DEFAULT_ORCHESTRATION_SETTINGS.wakes, ...overrides.wakes },
    watchdog: { ...DEFAULT_ORCHESTRATION_SETTINGS.watchdog, ...overrides.watchdog },
    github: { ...DEFAULT_ORCHESTRATION_SETTINGS.github, ...overrides.github },
    gate: { ...DEFAULT_ORCHESTRATION_SETTINGS.gate, ...(overrides.gate ?? {}) },
    roles,
    // Where `worker_start` adds worktrees; unset means next to the caller's worktree.
    ...(overrides.worktreeRoot ? { worktreeRoot: overrides.worktreeRoot } : {}),
  };
};

const normalize = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidSettings();
  const model = normalizeModel(value.defaultModel);
  const smallModel = normalizeModel(value.smallModel);
  const walkthroughModel = normalizeModel(value.walkthroughModel);
  const thinking = value.defaultThinking === null ? undefined : value.defaultThinking;
  if (thinking !== undefined && !isPiThinkingLevel(thinking)) throw invalidSettings();
  const thinkingByModel = normalizeThinkingByModel(value.defaultThinkingByModel);
  let fallbackThinking = thinking;
  if (fallbackThinking && model) {
    const key = `${model.providerId}/${model.modelId}`;
    if (!thinkingByModel[key]) thinkingByModel[key] = fallbackThinking;
    fallbackThinking = undefined;
  }
  const retryLimit = normalizeRetryLimit(value.defaultRetryLimit);
  const orchestration = normalizeOrchestration(value.orchestration);
  return {
    version: 1,
    ...(model ? { defaultModel: model } : {}),
    ...(smallModel ? { smallModel } : {}),
    ...(walkthroughModel ? { walkthroughModel } : {}),
    ...(Object.keys(thinkingByModel).length > 0 ? { defaultThinkingByModel: thinkingByModel } : {}),
    ...(fallbackThinking ? { defaultThinking: fallbackThinking } : {}),
    ...(retryLimit !== undefined ? { defaultRetryLimit: retryLimit } : {}),
    ...(orchestration ? { orchestration } : {}),
  };
};

/**
 * PiChamber-owned new-session defaults. This is intentionally separate from
 * Pi's settings.json: Pi remains authoritative when no PiChamber override is
 * configured, and credentials never enter this sidecar.
 */
export const PI_DEFAULT_RETRY_LIMIT = DEFAULT_RETRY_LIMIT;
export const PI_MIN_RETRY_LIMIT = MIN_RETRY_LIMIT;
export const PI_MAX_RETRY_LIMIT = MAX_RETRY_LIMIT;

export const createPiSettingsStore = ({ file = join(resolvePiChamberDataDir(), 'pi', 'settings.json') } = {}) => {
  let writeChain = Promise.resolve();

  const read = async () => {
    try {
      return normalize(JSON.parse(await readFile(file, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1 };
      if (error?.code === 'PI_SETTINGS_INVALID') throw error;
      throw invalidSettings();
    }
  };

  const update = async (patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalidSettings();
    const operation = writeChain.then(() => withCrossProcessLock(`${file}.lock`, async () => {
      const current = await read();
      const next = normalize({
        ...current,
        ...(Object.hasOwn(patch, 'defaultModel') ? { defaultModel: patch.defaultModel } : {}),
        ...(Object.hasOwn(patch, 'defaultThinking') ? { defaultThinking: patch.defaultThinking } : {}),
        ...(Object.hasOwn(patch, 'smallModel') ? { smallModel: patch.smallModel } : {}),
        ...(Object.hasOwn(patch, 'walkthroughModel') ? { walkthroughModel: patch.walkthroughModel } : {}),
        ...(Object.hasOwn(patch, 'defaultRetryLimit') ? { defaultRetryLimit: patch.defaultRetryLimit } : {}),
        ...(Object.hasOwn(patch, 'orchestration') ? { orchestration: mergeOrchestration(current.orchestration, patch.orchestration) } : {}),
        defaultThinkingByModel: Object.hasOwn(patch, 'defaultThinkingByModel')
          ? mergeThinkingByModel(current.defaultThinkingByModel ?? {}, patch.defaultThinkingByModel)
          : (current.defaultThinkingByModel ?? {}),
      });
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.tmp`;
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(temporary, file);
      return next;
    }));
    writeChain = operation.catch(() => {});
    return operation;
  };

  return { read, update };
};
