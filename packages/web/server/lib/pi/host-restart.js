/**
 * Builds the `restartHost` handler behind `POST /api/pi/runtime/restart`.
 *
 * Two phases, so a failure can still be reported: the returned promise
 * settles after everything that can fail has been done (the daemon stopped
 * and the host armed to bring the server back); `commit()` ends or replaces
 * this process and runs only after the HTTP reply has been written.
 *
 * `restartProcess` is the host's way back: the desktop app relaunches itself,
 * any other host replaces its own process (`createSelfReplace`). Without one
 * the server cannot come back, so there is no restart handler at all and the
 * route answers 501 before anything stops (#66). Environment hints such as
 * systemd's `INVOCATION_ID` are not read: systemd sets it for every process of
 * a user session, not only for services it restarts.
 *
 * A failure leaves the server usable: the daemon is started again on a
 * best-effort basis before the error is rethrown.
 */
export const createHostRestart = ({ getSupervisor, restartProcess = null } = {}) => {
  if (!restartProcess) return null;

  const stopDaemon = async (supervisor) => {
    try {
      await supervisor.stop();
    } catch (error) {
      // A daemon that is already gone has nothing to stop.
      if (error?.code !== 'DAEMON_UNAVAILABLE') throw error;
    }
  };

  return async () => {
    const supervisor = getSupervisor();
    if (!supervisor) {
      const error = new Error('The Pi session daemon is unavailable.');
      error.code = 'DAEMON_UNAVAILABLE';
      throw error;
    }
    try {
      await stopDaemon(supervisor);
      await restartProcess.prepare?.();
    } catch (error) {
      await supervisor.start().catch(() => {});
      throw error;
    }
    return { commit: restartProcess.commit };
  };
};

const DEFAULT_STOP_TIMEOUT_MS = 10_000;

/**
 * The way back for a server that is not hosted by the desktop app: replace
 * this process with the same command line and environment through
 * `process.execve`. The PID, the terminal and the port stay; the new image
 * loads the code that is on disk now.
 *
 * `execve` exists on POSIX only (Node >= 22.15, Bun >= 1.4). Where it is
 * missing, Windows, this returns null and restart is unsupported; there is
 * deliberately no detached-replacement fallback (PR #40, CONTEXT.md).
 *
 * `commit()` stops the server first so the port is free, but bounds that wait:
 * a stop that hangs on open sockets must not leave the instance half down.
 */
export const createSelfReplace = ({
  execve,
  execPath,
  execArgv = [],
  argv,
  env,
  checkExecutable,
  stopServer,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
} = {}) => {
  if (typeof execve !== 'function') return null;
  return {
    // Fails before anything stops when the executable is gone or not runnable.
    prepare: () => { checkExecutable(execPath); },
    commit: async () => {
      let timer;
      const timeout = new Promise((resolve) => { timer = setTimeout(resolve, stopTimeoutMs); });
      try {
        await Promise.race([Promise.resolve().then(stopServer), timeout]);
      } finally {
        clearTimeout(timer);
      }
      execve(execPath, [execPath, ...execArgv, ...argv.slice(1)], env);
    },
  };
};
