import fs from 'node:fs';
import path from 'node:path';

import { resolveLinuxLaunchExecutable } from './linux-autostart.mjs';

// How long the AppImage relaunch helper waits for this process to exit before
// it gives up, so a restart that never committed cannot start a second copy
// at some unrelated later quit.
const RELAUNCH_WAIT_SECONDS = 60;

// Waits for the old process ($1) to exit, then starts the AppImage ($2...).
// Runs from bash (or /bin/sh), outside the AppImage mount, which goes away
// with the old process. Chromium leaves some descriptors inheritable (the
// DevTools listen socket, for example); under bash the helper closes every
// descriptor above stderr so none of them leaks into the new instance. dash
// cannot address descriptors above 9, so plain sh skips that step.
const RELAUNCH_SCRIPT = [
  'pid="$1"; shift',
  'if [ -n "$BASH_VERSION" ]; then for fd in /proc/$$/fd/*; do n=${fd##*/}; [ "$n" -gt 2 ] 2>/dev/null && eval "exec $n>&-"; done; fi 2>/dev/null',
  `i=0; while kill -0 "$pid" 2>/dev/null; do i=$((i+1)); if [ "$i" -gt ${RELAUNCH_WAIT_SECONDS * 10} ]; then echo "pichamber restart: process $pid did not exit, not relaunching" >&2; exit 1; fi; sleep 0.1; done`,
  'exec "$@"',
].join('\n');

const isInside = (dir, entry) => entry === dir || entry.startsWith(`${dir}/`);

/**
 * The environment for the relaunched AppImage: this process's environment
 * without the entries that point into the old mount. The AppImage runtime of
 * the new process sets APPDIR, APPIMAGE, ARGV0 and OWD itself.
 */
export const relaunchEnvironment = (env) => {
  const appDir = typeof env.APPDIR === 'string' ? env.APPDIR.replace(/\/+$/, '') : '';
  const next = { ...env };
  for (const key of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'ELECTRON_RUN_AS_NODE']) delete next[key];
  if (!appDir) return next;
  for (const key of ['PATH', 'LD_LIBRARY_PATH']) {
    if (typeof next[key] !== 'string') continue;
    const kept = next[key].split(':').filter((entry) => entry && !isInside(appDir, entry));
    if (kept.length > 0) next[key] = kept.join(':');
    else delete next[key];
  }
  return next;
};

/**
 * The process half of "Restart PiChamber" for the desktop app, handed to the
 * in-process server as `restartProcess`.
 *
 * `prepare` arms the relaunch before the HTTP reply, so a failure is still
 * reported to the user. `commit` runs after the reply: the usual quit
 * preparation (tray, window state, background services, server stop) and
 * exit. It never waits for the server to drain, so a restart cannot hang on a
 * slow shutdown.
 *
 * From an AppImage ($APPIMAGE set) the relaunch does not use
 * `app.relaunch()`: started from inside the mount, that relaunch never brings
 * the new instance up (observed on Linux, the old mount is torn down with the
 * old process). A detached shell helper outside the mount waits for this
 * process to exit and then starts `$APPIMAGE`, so a replaced AppImage file
 * also starts the new build. Its output goes to `restart.log` in the logs
 * directory. Everything else keeps `app.relaunch()`.
 */
export const createDesktopRestartProcess = ({
  app,
  prepareForQuit,
  spawnProcess,
  env = process.env,
  execPath = process.execPath,
  argv = process.argv,
  pid = process.pid,
  homeDir = env.HOME,
  shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh',
}) => {
  const launchPath = resolveLinuxLaunchExecutable({ env, execPath });
  const fromAppImage = launchPath !== execPath;
  const args = argv.slice(1);

  const armAppImageRelaunch = () => {
    fs.accessSync(launchPath, fs.constants.X_OK);
    const logsDir = app.getPath('logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const log = fs.openSync(path.join(logsDir, 'restart.log'), 'a');
    try {
      const child = spawnProcess(shell, ['-c', RELAUNCH_SCRIPT, 'pichamber-restart', String(pid), launchPath, ...args], {
        cwd: homeDir || '/',
        env: relaunchEnvironment(env),
        detached: true,
        stdio: ['ignore', log, log],
      });
      child.unref();
    } finally {
      fs.closeSync(log);
    }
  };

  return {
    prepare: () => {
      if (fromAppImage) {
        armAppImageRelaunch();
        return;
      }
      app.relaunch({ execPath, args });
    },
    commit: () => {
      prepareForQuit();
      app.exit(0);
    },
  };
};
