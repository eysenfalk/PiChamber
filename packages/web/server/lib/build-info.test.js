import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BUILD_INFO_FILE,
  createBuildStamp,
  isBuildStamp,
  readBuildStamp,
  readGitBuildId,
  resolveServerBuild,
} from './build-info.js';

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd,
  stdio: ['ignore', 'pipe', 'ignore'],
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  },
});

describe('build stamp', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const makeRepo = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pichamber-build-info-'));
    dirs.push(dir);
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'tracked.txt'), 'one\n');
    git(dir, 'add', 'tracked.txt');
    git(dir, 'commit', '-q', '-m', 'first');
    return dir;
  };

  it('uses the short commit as the ID and a UTC ISO time', () => {
    const dir = makeRepo();
    const stamp = createBuildStamp({ cwd: dir, now: new Date('2026-10-04T08:09:10.000Z') });
    expect(stamp.id).toMatch(/^[0-9a-f]{7,}$/);
    expect(stamp.builtAt).toBe('2026-10-04T08:09:10.000Z');
    expect(isBuildStamp(stamp)).toBe(true);
  });

  it('adds -dirty only for tracked changes, not for untracked files', () => {
    const dir = makeRepo();
    const clean = readGitBuildId({ cwd: dir });
    writeFileSync(join(dir, 'untracked.txt'), 'x\n');
    expect(readGitBuildId({ cwd: dir })).toBe(clean);
    writeFileSync(join(dir, 'tracked.txt'), 'two\n');
    expect(readGitBuildId({ cwd: dir })).toBe(`${clean}-dirty`);
  });

  it('gives two builds of the same commit the same ID and different times', () => {
    const dir = makeRepo();
    const first = createBuildStamp({ cwd: dir, now: new Date('2026-10-04T08:00:00.000Z') });
    const second = createBuildStamp({ cwd: dir, now: new Date('2026-10-04T08:05:00.000Z') });
    expect(second.id).toBe(first.id);
    expect(second.builtAt).not.toBe(first.builtAt);
  });

  it('reports unknown outside a Git checkout instead of inventing an ID', () => {
    const failingGit = () => { throw new Error('not a repository'); };
    expect(readGitBuildId({ cwd: tmpdir(), runGit: failingGit })).toBe('unknown');
  });

  it('reads the stamp written next to the build and rejects malformed files', () => {
    const dist = mkdtempSync(join(tmpdir(), 'pichamber-build-dist-'));
    dirs.push(dist);
    expect(readBuildStamp(dist)).toBeNull();
    writeFileSync(join(dist, BUILD_INFO_FILE), '{"id":"abc1234-dirty","builtAt":"2026-10-04T08:09:10.000Z"}');
    expect(readBuildStamp(dist)).toEqual({ id: 'abc1234-dirty', builtAt: '2026-10-04T08:09:10.000Z' });
    writeFileSync(join(dist, BUILD_INFO_FILE), '{"id":"../x","builtAt":"2026-10-04T08:09:10.000Z"}');
    expect(readBuildStamp(dist)).toBeNull();
    writeFileSync(join(dist, BUILD_INFO_FILE), '{"id":"abc1234","builtAt":"not a date"}');
    expect(readBuildStamp(dist)).toBeNull();
  });

  it('describes a checkout without a build as source with the start time', () => {
    const dist = join(mkdtempSync(join(tmpdir(), 'pichamber-build-none-')), 'dist');
    dirs.push(join(dist, '..'));
    mkdirSync(dist);
    const startedAt = '2026-10-04T09:00:00.000Z';
    expect(resolveServerBuild({
      distDir: dist,
      cwd: tmpdir(),
      startedAt,
      runGit: (args) => (args[0] === 'rev-parse' ? 'abc1234' : ''),
    })).toEqual({ id: 'source-abc1234', builtAt: startedAt, kind: 'source' });
  });

  it('prefers the stamp of a real build over the source description', () => {
    const dist = mkdtempSync(join(tmpdir(), 'pichamber-build-real-'));
    dirs.push(dist);
    writeFileSync(join(dist, BUILD_INFO_FILE), '{"id":"abc1234","builtAt":"2026-10-04T08:09:10.000Z"}');
    expect(resolveServerBuild({ distDir: dist, cwd: tmpdir(), startedAt: '2026-10-05T00:00:00.000Z' })).toEqual({
      id: 'abc1234',
      builtAt: '2026-10-04T08:09:10.000Z',
      kind: 'build',
    });
  });
});
