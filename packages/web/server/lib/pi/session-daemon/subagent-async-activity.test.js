import { describe, expect, it } from 'vitest';

import { hasLiveSubagentRuns } from './subagent-async-activity.js';

const PREFIX = 'PI_SUBAGENT_ASYNC_JSON:';

const snapshot = (states, overrides = {}) => ({
  kind: 'pi-subagents.async-status-snapshot',
  version: 1,
  generatedAt: 1_700_000_000_000,
  caps: { maxRuns: 20, maxChildrenPerNode: 8, maxDepth: 3, maxStringLength: 160, maxSerializedBytes: 32768 },
  omitted: { runs: 0, children: 0, byteLimitExceeded: false },
  runs: states.map((state, index) => ({ id: `run-${index}`, kind: 'subagent', label: `run ${index}`, state })),
  ...overrides,
});

const lines = (value) => [`${PREFIX}${JSON.stringify(value)}`];

describe('hasLiveSubagentRuns', () => {
  it('is true when a top-level run is queued or running', () => {
    expect(hasLiveSubagentRuns(lines(snapshot(['running'])))).toBe(true);
    expect(hasLiveSubagentRuns(lines(snapshot(['queued'])))).toBe(true);
    expect(hasLiveSubagentRuns(lines(snapshot(['complete', 'failed', 'queued'])))).toBe(true);
    expect(hasLiveSubagentRuns(lines(snapshot(['stopped', 'running'])))).toBe(true);
  });

  it('is false for every state that has no work ahead', () => {
    for (const state of ['complete', 'failed', 'partial', 'paused', 'stopped', 'rejected']) {
      expect(hasLiveSubagentRuns(lines(snapshot([state, state])))).toBe(false);
    }
    expect(hasLiveSubagentRuns(lines(snapshot([])))).toBe(false);
  });

  it('reads the top-level run states only, not nested children', () => {
    const run = { id: 'a', kind: 'workflow', label: 'a', state: 'failed', children: [{ id: 'b', kind: 'step', label: 'b', state: 'queued' }] };
    expect(hasLiveSubagentRuns(lines(snapshot([], { runs: [run] })))).toBe(false);
  });

  it('is false for lines that are not a version 1 snapshot', () => {
    const valid = lines(snapshot(['running']));
    expect(hasLiveSubagentRuns(valid)).toBe(true);
    expect(hasLiveSubagentRuns([valid[0].slice(PREFIX.length)])).toBe(false);
    expect(hasLiveSubagentRuns([valid[0].slice(0, 80)])).toBe(false);
    expect(hasLiveSubagentRuns([`${PREFIX}{oops`])).toBe(false);
    expect(hasLiveSubagentRuns([PREFIX])).toBe(false);
    expect(hasLiveSubagentRuns(lines(snapshot(['running'], { version: 2 })))).toBe(false);
    expect(hasLiveSubagentRuns(lines(snapshot(['running'], { kind: 'pi-subagents.inspect-reply' })))).toBe(false);
    expect(hasLiveSubagentRuns(lines(snapshot(['running'], { runs: 'running' })))).toBe(false);
  });

  it('reads line 0 only', () => {
    expect(hasLiveSubagentRuns(['first', ...lines(snapshot(['running']))])).toBe(false);
  });

  it('never throws on unexpected input', () => {
    for (const value of [undefined, null, 7, 'text', {}, [], [null], [42], [{}], [`${PREFIX}null`], [`${PREFIX}[]`], [`${PREFIX}"running"`]]) {
      expect(hasLiveSubagentRuns(value)).toBe(false);
    }
    expect(hasLiveSubagentRuns(lines(snapshot([], { runs: [null, 3, 'running', { state: 7 }] })))).toBe(false);
    const hostile = { get length() { throw new Error('boom'); } };
    expect(hasLiveSubagentRuns(hostile)).toBe(false);
  });
});
