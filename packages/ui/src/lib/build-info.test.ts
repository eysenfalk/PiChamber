import { describe, expect, test } from 'bun:test';

import {
  describeBuildMismatch,
  findBuildMismatch,
  formatBuildTime,
  getUiBuild,
  readServerBuilds,
} from './build-info';

const build = (id: string, builtAt: string) => ({ id, builtAt });

describe('findBuildMismatch', () => {
  const same = build('abc1234', '2026-10-04T08:00:00.000Z');

  test('matching builds have no mismatch', () => {
    expect(findBuildMismatch({ ui: same, server: { ...same, kind: 'build' }, daemon: { id: 'abc1234', builtAt: same.builtAt } })).toBeNull();
  });

  test('flags a UI newer than the server', () => {
    const mismatch = findBuildMismatch({
      ui: build('def5678', '2026-10-04T09:00:00.000Z'),
      server: { ...same, kind: 'build' },
      daemon: { id: 'abc1234' },
    });
    expect(mismatch).toBe('ui-newer-than-server');
    expect(describeBuildMismatch(mismatch!)).toContain('Restart PiChamber');
  });

  test('flags a UI older than the server and asks for a reload instead of a restart', () => {
    const mismatch = findBuildMismatch({
      ui: build('old0000', '2026-10-03T09:00:00.000Z'),
      server: { ...same, kind: 'build' },
      daemon: { id: 'abc1234' },
    });
    expect(mismatch).toBe('ui-older-than-server');
    expect(describeBuildMismatch(mismatch!)).toContain('Reload');
  });

  test('flags a daemon from an older build than the server', () => {
    const mismatch = findBuildMismatch({
      ui: same,
      server: { ...same, kind: 'build' },
      daemon: { id: 'old0000', builtAt: '2026-10-03T09:00:00.000Z' },
    });
    expect(mismatch).toBe('daemon-older-than-server');
    expect(describeBuildMismatch(mismatch!)).toContain('Restart PiChamber');
  });

  test('flags a daemon with another ID and no usable time', () => {
    expect(findBuildMismatch({ ui: same, server: { ...same, kind: 'build' }, daemon: { id: 'zzz9999' } })).toBe('daemon-differs-from-server');
  });

  test('does not compare the UI with a source checkout, which has no build', () => {
    expect(findBuildMismatch({
      ui: build('def5678-dirty', '2026-10-04T09:00:00.000Z'),
      server: { id: 'source-abc1234', builtAt: '2026-10-04T08:00:00.000Z', kind: 'source' },
      daemon: { id: 'source-abc1234' },
    })).toBeNull();
  });

  test('reports nothing when a stamp is unknown', () => {
    expect(findBuildMismatch({ ui: null, server: null, daemon: null })).toBeNull();
    expect(findBuildMismatch({ ui: same, server: null, daemon: { id: 'x' } })).toBeNull();
  });
});

describe('readServerBuilds', () => {
  test('reads the server and daemon stamps from the system info', () => {
    expect(readServerBuilds({
      serverBuild: { id: 'abc1234', builtAt: '2026-10-04T08:00:00.000Z', kind: 'build' },
      daemonBuild: { id: 'abc1234', builtAt: '2026-10-04T08:00:00.000Z' },
    })).toEqual({
      server: { id: 'abc1234', builtAt: '2026-10-04T08:00:00.000Z', kind: 'build' },
      daemon: { id: 'abc1234', builtAt: '2026-10-04T08:00:00.000Z' },
    });
  });

  test('treats missing or malformed stamps as unknown', () => {
    expect(readServerBuilds({ serverBuild: { id: 'x', builtAt: 'nope' }, daemonBuild: null })).toEqual({ server: null, daemon: null });
    expect(readServerBuilds(null)).toEqual({ server: null, daemon: null });
  });
});

describe('formatBuildTime', () => {
  test('formats an ISO time in the viewer locale and time zone', () => {
    const text = formatBuildTime('2026-10-04T08:09:10.000Z', 'en-US');
    expect(text).toContain('2026');
    expect(text).toContain('Oct');
  });

  test('names an unknown time', () => {
    expect(formatBuildTime(undefined)).toBe('unknown time');
    expect(formatBuildTime('not a date')).toBe('unknown time');
  });
});

describe('getUiBuild', () => {
  test('is null when the bundle was not built by Vite', () => {
    expect(getUiBuild()).toBeNull();
  });
});
