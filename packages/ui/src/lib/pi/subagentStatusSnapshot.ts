/**
 * Parser for the async run snapshot that pi-subagents publishes to RPC hosts as
 * one extension widget line: `PI_SUBAGENT_ASYNC_JSON:` followed by a JSON
 * `pi-subagents.async-status-snapshot`. The types below mirror version 1 of
 * that protocol (pi-subagents `async-status-projection.ts`); the parser
 * accepts nothing else, so a producer that bumps the version shows as
 * unavailable instead of being half understood. It never throws.
 */

export const SUBAGENT_ASYNC_WIDGET_KEY = 'subagent-async';
/** Carries on-demand inspect replies; hosts must not render it. */
export const SUBAGENT_INSPECT_WIDGET_KEY = 'subagent-inspect';

const SUBAGENT_ASYNC_LINE_PREFIX = 'PI_SUBAGENT_ASYNC_JSON:';
const SNAPSHOT_KIND = 'pi-subagents.async-status-snapshot';
const SNAPSHOT_VERSION = 1;
// The producer caps depth at 3 by default; this is only a recursion guard for
// input that claims more.
const MAX_NODE_DEPTH = 8;

export type SubagentStatusState =
  | 'queued'
  | 'running'
  | 'complete'
  | 'failed'
  | 'partial'
  | 'paused'
  | 'stopped'
  | 'rejected';

const NODE_STATES: Record<SubagentStatusState, true> = {
  queued: true,
  running: true,
  complete: true,
  failed: true,
  partial: true,
  paused: true,
  stopped: true,
  rejected: true,
};

export type SubagentStatusNodeKind = 'subagent' | 'workflow' | 'step' | 'host-step';

const NODE_KINDS: Record<SubagentStatusNodeKind, true> = {
  subagent: true,
  workflow: true,
  step: true,
  'host-step': true,
};

export interface SubagentStatusActivity {
  state?: string;
  currentTool?: string;
  lastActivityAt?: number;
  currentToolStartedAt?: number;
  turnCount?: number;
  toolCount?: number;
}

export interface SubagentStatusNode {
  id: string;
  kind: SubagentStatusNodeKind;
  label: string;
  state: SubagentStatusState;
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
  activity?: SubagentStatusActivity;
  children?: SubagentStatusNode[];
}

export interface SubagentStatusSnapshot {
  version: 1;
  generatedAt: number;
  omitted: { runs: number; children: number; byteLimitExceeded: boolean };
  runs: SubagentStatusNode[];
}

export type SubagentStatusParseResult =
  | { ok: true; snapshot: SubagentStatusSnapshot }
  | { ok: false };

const FAILURE: SubagentStatusParseResult = { ok: false };

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isCount = (value: unknown): value is number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
);

const ACTIVITY_TEXT_KEYS = ['state', 'currentTool'] as const;
const ACTIVITY_COUNT_KEYS = ['lastActivityAt', 'currentToolStartedAt', 'turnCount', 'toolCount'] as const;

/** `undefined` when absent, `null` when present but malformed. */
const parseActivity = (value: unknown): SubagentStatusActivity | undefined | null => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const activity: SubagentStatusActivity = {};
  for (const key of ACTIVITY_TEXT_KEYS) {
    const field = value[key];
    if (field === undefined) continue;
    if (typeof field !== 'string') return null;
    activity[key] = field;
  }
  for (const key of ACTIVITY_COUNT_KEYS) {
    const field = value[key];
    if (field === undefined) continue;
    if (!isCount(field)) return null;
    activity[key] = field;
  }
  return activity;
};

const NODE_TIME_KEYS = ['startedAt', 'updatedAt', 'endedAt'] as const;

const parseNode = (value: unknown, depth: number): SubagentStatusNode | null => {
  if (!isRecord(value) || depth > MAX_NODE_DEPTH) return null;
  const { id, kind, label, state } = value;
  if (typeof id !== 'string' || typeof label !== 'string') return null;
  if (typeof kind !== 'string' || !Object.hasOwn(NODE_KINDS, kind)) return null;
  if (typeof state !== 'string' || !Object.hasOwn(NODE_STATES, state)) return null;
  for (const key of NODE_TIME_KEYS) {
    if (value[key] !== undefined && !isCount(value[key])) return null;
  }
  const { startedAt, updatedAt, endedAt } = value as { startedAt?: number; updatedAt?: number; endedAt?: number };
  const activity = parseActivity(value.activity);
  if (activity === null) return null;

  let children: SubagentStatusNode[] | undefined;
  if (value.children !== undefined) {
    if (!Array.isArray(value.children)) return null;
    children = [];
    for (const child of value.children) {
      const parsed = parseNode(child, depth + 1);
      if (!parsed) return null;
      children.push(parsed);
    }
  }

  return {
    id,
    kind: kind as SubagentStatusNodeKind,
    label,
    state: state as SubagentStatusState,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(activity !== undefined ? { activity } : {}),
    ...(children && children.length > 0 ? { children } : {}),
  };
};

/** Parse one widget line; any prefix, JSON, version, or shape problem is a failure. */
export const parseSubagentStatusLine = (line: string): SubagentStatusParseResult => {
  if (typeof line !== 'string' || !line.startsWith(SUBAGENT_ASYNC_LINE_PREFIX)) return FAILURE;
  let payload: unknown;
  try {
    payload = JSON.parse(line.slice(SUBAGENT_ASYNC_LINE_PREFIX.length));
  } catch {
    return FAILURE;
  }
  if (!isRecord(payload) || payload.kind !== SNAPSHOT_KIND || payload.version !== SNAPSHOT_VERSION) return FAILURE;
  if (!isCount(payload.generatedAt) || !Array.isArray(payload.runs)) return FAILURE;
  const omitted = payload.omitted;
  if (!isRecord(omitted) || !isCount(omitted.runs) || !isCount(omitted.children)) return FAILURE;
  if (typeof omitted.byteLimitExceeded !== 'boolean') return FAILURE;

  const runs: SubagentStatusNode[] = [];
  for (const run of payload.runs) {
    const parsed = parseNode(run, 0);
    if (!parsed) return FAILURE;
    runs.push(parsed);
  }
  return {
    ok: true,
    snapshot: {
      version: SNAPSHOT_VERSION,
      generatedAt: payload.generatedAt,
      omitted: { runs: omitted.runs, children: omitted.children, byteLimitExceeded: omitted.byteLimitExceeded },
      runs,
    },
  };
};
