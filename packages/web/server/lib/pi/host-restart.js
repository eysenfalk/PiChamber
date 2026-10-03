/**
 * Builds the `restartHost` handler behind `POST /api/pi/runtime/restart`.
 *
 * Two phases, so a failure can still be reported: the returned promise
 * settles after everything that can fail has been done (the daemon stopped
 * and, when the server process itself will go, the host armed to restart it);
 * `commit()` is the part that ends or replaces this process and runs only
 * after the HTTP reply has been written.
 *
 * Which restart happens depends on who can bring the server back:
 * - the host passed `restartProcess` (the desktop app relaunches itself), or
 * - a process manager is present (systemd sets `INVOCATION_ID`) and restarts
 *   the process once it exits,
 * - otherwise nothing can bring this server back, so only the session daemon
 *   restarts and the caller is told so (`scope: 'daemon'`).
 *
 * A failure leaves the server usable: the daemon is started again on a
 * best-effort basis before the error is rethrown.
 */
export const createHostRestart = ({
  getSupervisor,
  restartProcess = null,
  env = process.env,
  exitProcess,
} = {}) => {
  const managedByProcessManager = typeof env?.INVOCATION_ID === 'string' && env.INVOCATION_ID.length > 0;
  const processRestart = restartProcess
    ?? (managedByProcessManager && typeof exitProcess === 'function'
      ? { prepare: () => {}, commit: exitProcess }
      : null);

  const stopDaemon = async (supervisor) => {
    try {
      await supervisor.stop();
    } catch (error) {
      // A daemon that is already gone has nothing to stop; start() recovers it.
      if (error?.code !== 'DAEMON_UNAVAILABLE') throw error;
    }
  };

  const restoreDaemon = (supervisor) => supervisor.start().catch(() => {});

  return async () => {
    const supervisor = getSupervisor();
    if (!supervisor) {
      const error = new Error('The Pi session daemon is unavailable.');
      error.code = 'DAEMON_UNAVAILABLE';
      throw error;
    }

    if (!processRestart) {
      try {
        await stopDaemon(supervisor);
        await supervisor.start();
      } catch (error) {
        await restoreDaemon(supervisor);
        throw error;
      }
      return { scope: 'daemon' };
    }

    try {
      await stopDaemon(supervisor);
      await processRestart.prepare?.();
    } catch (error) {
      await restoreDaemon(supervisor);
      throw error;
    }
    return { scope: 'process', commit: processRestart.commit };
  };
};
