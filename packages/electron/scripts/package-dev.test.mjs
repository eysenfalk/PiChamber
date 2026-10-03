import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEV_APPIMAGE_NAME, installDevAppImage, resolveDevOutputDir } from './package-dev.mjs';

const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const git = (cwd, args) => execFileSync('git', args, { cwd, env: { ...process.env, ...identity }, stdio: 'ignore' });
const temp = (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'package-dev-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('dev output resolves to the main checkout, also from a linked worktree', (t) => {
  const root = temp(t);
  const main = path.join(root, 'main');
  fs.mkdirSync(path.join(main, 'packages', 'electron'), { recursive: true });
  fs.writeFileSync(path.join(main, 'packages', 'electron', 'package.json'), '{}');
  git(main, ['init', '--quiet']);
  git(main, ['add', '.']);
  git(main, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'init']);
  const linked = path.join(root, 'linked');
  git(main, ['worktree', 'add', '--quiet', '-b', 'feature', linked]);
  const expected = path.join(main, 'packages', 'electron', 'dist', 'dev');
  assert.equal(resolveDevOutputDir(path.join(main, 'packages', 'electron')), expected);
  assert.equal(resolveDevOutputDir(path.join(linked, 'packages', 'electron')), expected);
});

test('dev output falls back to the package directory outside git', (t) => {
  const dir = temp(t);
  assert.equal(resolveDevOutputDir(dir), path.join(dir, 'dist', 'dev'));
});

test('installing replaces the stable AppImage atomically and keeps a running inode readable', (t) => {
  const outputDir = temp(t);
  const target = path.join(outputDir, DEV_APPIMAGE_NAME);
  fs.writeFileSync(target, 'old build');
  const running = fs.openSync(target, 'r');
  t.after(() => fs.closeSync(running));
  const buildDir = fs.mkdtempSync(path.join(outputDir, '.build-'));
  fs.writeFileSync(path.join(buildDir, 'PiChamber-1.0.3-linux-x86_64.AppImage'), 'new build');
  fs.writeFileSync(path.join(buildDir, 'latest-linux.yml'), 'ignored');

  assert.equal(installDevAppImage(buildDir, outputDir), target);
  assert.equal(fs.readFileSync(target, 'utf8'), 'new build');
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(running, 'utf8'), 'old build');
});

test('a build without exactly one AppImage leaves the previous file untouched', (t) => {
  const outputDir = temp(t);
  const target = path.join(outputDir, DEV_APPIMAGE_NAME);
  fs.writeFileSync(target, 'old build');
  const buildDir = fs.mkdtempSync(path.join(outputDir, '.build-'));
  assert.throws(() => installDevAppImage(buildDir, outputDir), /found 0/);
  fs.writeFileSync(path.join(buildDir, 'a.AppImage'), 'a');
  fs.writeFileSync(path.join(buildDir, 'b.AppImage'), 'b');
  assert.throws(() => installDevAppImage(buildDir, outputDir), /found 2/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old build');
});
