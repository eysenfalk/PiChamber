import { resolveLinuxLaunchExecutable } from './linux-autostart.mjs';

/**
 * The process half of "Restart PiChamber" for the desktop app, handed to the
 * in-process server as `restartProcess`.
 *
 * `prepare` arms the relaunch before the HTTP reply, so a failure is still
 * reported to the user. It starts from `$APPIMAGE` when set: after the
 * AppImage file was replaced, `process.execPath` still points into the old
 * mount and would start the old build again.
 *
 * `commit` runs after the reply: the usual quit preparation (tray, window
 * state, background services, server stop) and exit. It never waits for the
 * server to drain, so a restart cannot hang on a slow shutdown.
 */
export const createDesktopRestartProcess = ({
  app,
  prepareForQuit,
  env = process.env,
  execPath = process.execPath,
  argv = process.argv,
}) => ({
  prepare: () => {
    app.relaunch({
      execPath: resolveLinuxLaunchExecutable({ env, execPath }),
      args: argv.slice(1),
    });
  },
  commit: () => {
    prepareForQuit();
    app.exit(0);
  },
});
