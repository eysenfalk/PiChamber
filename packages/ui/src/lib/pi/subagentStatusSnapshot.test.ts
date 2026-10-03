import { describe, expect, test } from 'bun:test';

import { parseSubagentStatusLine } from './subagentStatusSnapshot';

const PREFIX = 'PI_SUBAGENT_ASYNC_JSON:';

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  kind: 'pi-subagents.async-status-snapshot',
  version: 1,
  generatedAt: 1_700_000_100_000,
  caps: { maxRuns: 20, maxChildrenPerNode: 8, maxDepth: 3, maxStringLength: 160, maxSerializedBytes: 32768 },
  omitted: { runs: 0, children: 0, byteLimitExceeded: false },
  runs: [
    {
      id: 'run-1',
      kind: 'subagent',
      label: 'scout',
      state: 'running',
      startedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_090_000,
      activity: { state: 'active', currentTool: 'read', lastActivityAt: 1_700_000_090_000, turnCount: 2, toolCount: 5 },
    },
  ],
  ...overrides,
});

const line = (value: unknown) => `${PREFIX}${JSON.stringify(value)}`;

describe('parseSubagentStatusLine', () => {
  test('parses a valid snapshot with run state, timing, and activity', () => {
    const result = parseSubagentStatusLine(line(snapshot()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.generatedAt).toBe(1_700_000_100_000);
    expect(result.snapshot.runs).toEqual([
      {
        id: 'run-1',
        kind: 'subagent',
        label: 'scout',
        state: 'running',
        startedAt: 1_700_000_000_000,
        updatedAt: 1_700_000_090_000,
        activity: { state: 'active', currentTool: 'read', lastActivityAt: 1_700_000_090_000, turnCount: 2, toolCount: 5 },
      },
    ]);
  });

  test('parses nested children and every documented state and kind', () => {
    const states = ['queued', 'running', 'complete', 'failed', 'partial', 'paused', 'stopped', 'rejected'];
    const kinds = ['subagent', 'workflow', 'step', 'host-step'];
    const run = {
      id: 'wf',
      kind: 'workflow',
      label: 'review',
      state: 'running',
      children: states.map((state, index) => ({
        id: `child-${index}`,
        kind: kinds[index % kinds.length],
        label: state,
        state,
        children: index === 0 ? [{ id: 'grandchild', kind: 'step', label: 'inner', state: 'complete', endedAt: 5 }] : undefined,
      })),
    };
    const result = parseSubagentStatusLine(line(snapshot({ runs: [run] })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const children = result.snapshot.runs[0]?.children ?? [];
    expect(children.map((child) => child.state)).toEqual(states);
    expect(children[0]?.children?.[0]).toMatchObject({ id: 'grandchild', endedAt: 5 });
  });

  test('keeps omitted run and child counts', () => {
    const result = parseSubagentStatusLine(line(snapshot({ omitted: { runs: 3, children: 7, byteLimitExceeded: true } })));
    expect(result.ok && result.snapshot.omitted).toEqual({ runs: 3, children: 7, byteLimitExceeded: true });
  });

  test('accepts an empty run list', () => {
    const result = parseSubagentStatusLine(line(snapshot({ runs: [] })));
    expect(result.ok && result.snapshot.runs).toEqual([]);
  });

  test('fails without the prefix, on malformed JSON, and on truncated JSON', () => {
    const valid = line(snapshot());
    expect(parseSubagentStatusLine(valid.slice(PREFIX.length)).ok).toBe(false);
    expect(parseSubagentStatusLine(`${PREFIX}{not json`).ok).toBe(false);
    expect(parseSubagentStatusLine(`${PREFIX}`).ok).toBe(false);
    expect(parseSubagentStatusLine(valid.slice(0, Math.floor(valid.length / 2))).ok).toBe(false);
    expect(parseSubagentStatusLine(`${PREFIX}[]`).ok).toBe(false);
    expect(parseSubagentStatusLine(`${PREFIX}null`).ok).toBe(false);
  });

  test('fails on an unknown version or kind', () => {
    expect(parseSubagentStatusLine(line(snapshot({ version: 2 }))).ok).toBe(false);
    expect(parseSubagentStatusLine(line(snapshot({ version: '1' }))).ok).toBe(false);
    expect(parseSubagentStatusLine(line(snapshot({ kind: 'pi-subagents.inspect-reply' }))).ok).toBe(false);
  });

  test('fails on malformed top-level fields', () => {
    expect(parseSubagentStatusLine(line(snapshot({ runs: 'none' }))).ok).toBe(false);
    expect(parseSubagentStatusLine(line(snapshot({ generatedAt: -1 }))).ok).toBe(false);
    expect(parseSubagentStatusLine(line(snapshot({ omitted: undefined }))).ok).toBe(false);
    expect(parseSubagentStatusLine(line(snapshot({ omitted: { runs: -1, children: 0, byteLimitExceeded: false } }))).ok).toBe(false);
    expect(parseSubagentStatusLine(line(snapshot({ omitted: { runs: 0, children: 0 } }))).ok).toBe(false);
  });

  test('fails on a malformed node anywhere in the tree', () => {
    const bad = (node: Record<string, unknown>) => parseSubagentStatusLine(line(snapshot({ runs: [node] }))).ok;
    const base = { id: 'a', kind: 'subagent', label: 'a', state: 'running' };
    expect(bad(base)).toBe(true);
    expect(bad({ ...base, state: 'exploded' })).toBe(false);
    expect(bad({ ...base, kind: 'robot' })).toBe(false);
    expect(bad({ ...base, id: 7 })).toBe(false);
    expect(bad({ ...base, label: undefined })).toBe(false);
    expect(bad({ ...base, startedAt: 'yesterday' })).toBe(false);
    expect(bad({ ...base, activity: 'busy' })).toBe(false);
    expect(bad({ ...base, activity: { currentTool: 3 } })).toBe(false);
    expect(bad({ ...base, activity: { toolCount: -2 } })).toBe(false);
    expect(bad({ ...base, children: 'many' })).toBe(false);
    expect(bad({ ...base, children: [{ id: 'b', kind: 'step', label: 'b', state: 'nope' }] })).toBe(false);
    expect(bad({ ...base, children: [42] })).toBe(false);
    // Prototype names are not states.
    expect(bad({ ...base, state: 'constructor' })).toBe(false);
  });

  test('fails on nesting deeper than the recursion guard without throwing', () => {
    let node: Record<string, unknown> = { id: 'leaf', kind: 'step', label: 'leaf', state: 'running' };
    for (let depth = 0; depth < 20; depth += 1) {
      node = { id: `n${depth}`, kind: 'step', label: 'n', state: 'running', children: [node] };
    }
    expect(parseSubagentStatusLine(line(snapshot({ runs: [node] }))).ok).toBe(false);
  });

  test('never throws on non-string input', () => {
    expect(parseSubagentStatusLine(undefined as unknown as string).ok).toBe(false);
    expect(parseSubagentStatusLine(12 as unknown as string).ok).toBe(false);
  });
});
