import assert from 'node:assert/strict';
import test from 'node:test';

import { createDesktopRestartProcess } from './desktop-restart.mjs';

const fakeApp = () => {
  const calls = [];
  return {
    calls,
    relaunch: (options) => calls.push(['relaunch', options]),
    exit: (code) => calls.push(['exit', code]),
  };
};

test('relaunches from the AppImage path so a replaced AppImage starts the new build', () => {
  const app = fakeApp();
  const restart = createDesktopRestartProcess({
    app,
    prepareForQuit: () => app.calls.push(['prepareForQuit']),
    env: { APPIMAGE: '/home/user/PiChamber.AppImage' },
    execPath: '/tmp/.mount_PiChabc/pichamber',
    argv: ['/tmp/.mount_PiChabc/pichamber', '--background'],
  });
  restart.prepare();
  assert.deepEqual(app.calls, [['relaunch', { execPath: '/home/user/PiChamber.AppImage', args: ['--background'] }]]);
});

test('relaunches the current executable when not running from an AppImage', () => {
  const app = fakeApp();
  const restart = createDesktopRestartProcess({
    app,
    prepareForQuit: () => {},
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
    env: {},
    execPath: '/opt/PiChamber/pichamber',
    argv: ['/opt/PiChamber/pichamber'],
  });
  assert.throws(() => restart.prepare(), failure);
});
