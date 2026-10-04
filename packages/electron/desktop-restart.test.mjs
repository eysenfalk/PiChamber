import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { createDesktopRestartProcess, relaunchEnvironment } from './desktop-restart.mjs';

const temp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-restart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const fakeApp = (logsDir = '/nonexistent') => {
  const calls = [];
  return {
    calls,
    relaunch: (options) => calls.push(['relaunch', options]),
    exit: (code) => calls.push(['exit', code]),
    getPath: (name) => (name === 'logs' ? logsDir : assert.fail(`unexpected getPath(${name})`)),
  };
};

const fakeAppImage = (dir, body = 'exit 0') => {
  const file = path.join(dir, 'PiChamber.AppImage');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
};

test('from an AppImage the relaunch runs through a detached shell helper, not app.relaunch', (t) => {
  const dir = temp(t);
  const appImage = fakeAppImage(dir);
  const app = fakeApp(path.join(dir, 'logs'));
  const spawned = [];
  const restart = createDesktopRestartProcess({
    app,
    prepareForQuit: () => {},
    spawnProcess: (command, args, options) => {
      spawned.push({ command, args, options });
      return { unref: () => spawned.push('unref') };
    },
    env: { APPIMAGE: appImage, APPDIR: '/tmp/.mount_PiChabc', HOME: '/home/user', PATH: '/tmp/.mount_PiChabc:/usr/bin' },
    execPath: '/tmp/.mount_PiChabc/pichamber',
    argv: ['/tmp/.mount_PiChabc/pichamber', '--background'],
    pid: 4242,
    shell: '/bin/sh',
  });
  restart.prepare();

  assert.deepEqual(app.calls, []);
  const [{ command, args, options }, unref] = spawned;
  assert.equal(command, '/bin/sh');
  assert.deepEqual(args.slice(2), ['pichamber-restart', '4242', appImage, '--background']);
  assert.equal(options.detached, true);
  assert.equal(options.cwd, '/home/user');
  assert.equal(options.env.PATH, '/usr/bin');
  assert.equal(options.env.APPDIR, undefined);
  assert.equal(unref, 'unref');
  assert.ok(fs.existsSync(path.join(dir, 'logs', 'restart.log')));
});

test('a missing or non-executable AppImage fails prepare, so the restart is reported as failed', (t) => {
  const dir = temp(t);
  const notExecutable = path.join(dir, 'plain.AppImage');
  fs.writeFileSync(notExecutable, '', { mode: 0o644 });
  for (const APPIMAGE of [path.join(dir, 'missing.AppImage'), notExecutable]) {
    const restart = createDesktopRestartProcess({
      app: fakeApp(path.join(dir, 'logs')),
      prepareForQuit: () => assert.fail('must not prepare for quit'),
      spawnProcess: () => assert.fail('must not spawn'),
      env: { APPIMAGE },
      execPath: '/tmp/.mount_PiChabc/pichamber',
      argv: ['/tmp/.mount_PiChabc/pichamber'],
    });
    assert.throws(() => restart.prepare(), (error) => error.code === 'ENOENT' || error.code === 'EACCES');
  }
});

test('the helper starts the AppImage only after the old process exited, with its arguments', async (t) => {
  const dir = temp(t);
  const marker = path.join(dir, 'started');
  const appImage = fakeAppImage(dir, `echo "$@" > "${marker}"`);
  const old = spawn('sleep', ['0.7'], { stdio: 'ignore' });
  createDesktopRestartProcess({
    app: fakeApp(path.join(dir, 'logs')),
    prepareForQuit: () => {},
    spawnProcess: spawn,
    env: { APPIMAGE: appImage, HOME: dir, PATH: process.env.PATH },
    execPath: '/tmp/.mount_PiChabc/pichamber',
    argv: ['/tmp/.mount_PiChabc/pichamber', '--background'],
    pid: old.pid,
  }).prepare();

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fs.existsSync(marker), false, 'started while the old process was still running');
  await new Promise((resolve) => old.once('exit', resolve));
  for (let i = 0; i < 50 && !fs.existsSync(marker); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), '--background');
});

test('under bash the helper closes inherited descriptors before starting the AppImage', async (t) => {
  if (!fs.existsSync('/bin/bash')) return t.skip('no /bin/bash');
  const dir = temp(t);
  const marker = path.join(dir, 'fds');
  const appImage = fakeAppImage(dir, `ls /proc/$$/fd > "${marker}"`);
  // Opens descriptors 7 and 129 without close-on-exec, like Chromium's
  // DevTools socket, before running the helper.
  const leaky = (command, args, options) => spawn('/bin/bash', ['-c', 'exec 7>/dev/null 129>/dev/null; exec "$0" "$@"', command, ...args], options);
  createDesktopRestartProcess({
    app: fakeApp(path.join(dir, 'logs')),
    prepareForQuit: () => {},
    spawnProcess: leaky,
    env: { APPIMAGE: appImage, HOME: dir, PATH: process.env.PATH },
    execPath: '/tmp/.mount_PiChabc/pichamber',
    argv: ['/tmp/.mount_PiChabc/pichamber'],
    pid: 2147483646,
    shell: '/bin/bash',
  }).prepare();
  for (let i = 0; i < 50 && !fs.existsSync(marker); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  const fds = fs.readFileSync(marker, 'utf8').split(/\s+/).filter(Boolean).map(Number);
  assert.ok(!fds.includes(7) && !fds.includes(129), `leaked descriptors: ${fds.join(',')}`);
});

test('the relaunch environment drops the old mount and AppImage runtime variables', () => {
  const env = relaunchEnvironment({
    APPDIR: '/tmp/.mount_PiChabc/',
    APPIMAGE: '/home/user/PiChamber.AppImage',
    ARGV0: 'x',
    OWD: '/home/user',
    ELECTRON_RUN_AS_NODE: '1',
    PATH: '/tmp/.mount_PiChabc:/tmp/.mount_PiChabc/usr/sbin:/usr/bin:/tmp/.mount_PiChabcd',
    LD_LIBRARY_PATH: '/tmp/.mount_PiChabc/usr/lib:',
    HOME: '/home/user',
  });
  assert.deepEqual(env, { PATH: '/usr/bin:/tmp/.mount_PiChabcd', HOME: '/home/user' });
});

test('relaunches the current executable through app.relaunch when not running from an AppImage', () => {
  const app = fakeApp();
  const restart = createDesktopRestartProcess({
    app,
    prepareForQuit: () => {},
    spawnProcess: () => assert.fail('must not spawn'),
    env: {},
    execPath: '/opt/PiChamber/pichamber',
    argv: ['/opt/PiChamber/pichamber'],
  });
  restart.prepare();
  assert.deepEqual(app.calls, [['relaunch', { execPath: '/opt/PiChamber/pichamber', args: [] }]]);
});

test('ignores a relative or empty APPIMAGE value', () => {
  for (const APPIMAGE of ['', '   ', 'PiChamber.AppImage']) {
    const app = fakeApp();
    createDesktopRestartProcess({
      app,
      prepareForQuit: () => {},
      spawnProcess: () => assert.fail('must not spawn'),
      env: { APPIMAGE },
      execPath: '/opt/PiChamber/pichamber',
      argv: ['/opt/PiChamber/pichamber'],
    }).prepare();
    assert.equal(app.calls[0][1].execPath, '/opt/PiChamber/pichamber');
  }
});

test('commit runs the quit preparation and then exits, without relaunching again', () => {
  const app = fakeApp();
  const restart = createDesktopRestartProcess({
    app,
    prepareForQuit: () => app.calls.push(['prepareForQuit']),
    spawnProcess: () => assert.fail('must not spawn'),
    env: {},
    execPath: '/opt/PiChamber/pichamber',
    argv: ['/opt/PiChamber/pichamber'],
  });
  restart.commit();
  assert.deepEqual(app.calls, [['prepareForQuit'], ['exit', 0]]);
});

test('prepare lets a relaunch failure reach the caller so the restart is reported as failed', () => {
  const failure = new Error('relaunch failed');
  const restart = createDesktopRestartProcess({
    app: { relaunch: () => { throw failure; }, exit: () => assert.fail('must not exit') },
    prepareForQuit: () => assert.fail('must not prepare for quit'),
    spawnProcess: () => assert.fail('must not spawn'),
    env: {},
    execPath: '/opt/PiChamber/pichamber',
    argv: ['/opt/PiChamber/pichamber'],
  });
  assert.throws(() => restart.prepare(), failure);
});
