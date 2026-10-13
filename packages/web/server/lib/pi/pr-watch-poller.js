// Polls GitHub for the pull requests of workers (#119). The GitHub module
// lives in the web server, the diff and the wakes in the session daemon, so
// each tick asks the daemon what to read and hands the reads back. The daemon
// answers with no targets while no worker has a pull request, which makes an
// idle tick cost one IPC request and no GitHub call.

export const createPrWatchPoller = ({ supervisor, readPullWatch, intervalMs = 60_000 }) => {
  let timer = null;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { targets } = await supervisor.request('orchestration.prWatch', {});
      const settled = await Promise.allSettled(targets.map(({ directory, repository, number }) => readPullWatch({ directory, repository, number })));
      const reads = [];
      settled.forEach((outcome, index) => {
        const { sessionId, repository, number } = targets[index];
        if (outcome.status === 'fulfilled' && outcome.value) reads.push({ sessionId, repository, number, read: outcome.value });
        else if (outcome.status === 'rejected') console.warn(`[PrWatch] read failed: ${outcome.reason?.code ?? 'UNKNOWN'}`);
      });
      if (reads.length > 0) await supervisor.request('orchestration.prWatch', { reads });
    } catch (error) {
      console.warn(`[PrWatch] tick failed: ${error?.code ?? 'UNKNOWN'}`);
    } finally {
      running = false;
    }
  };

  return {
    start: () => {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref?.();
    },
    stop: () => {
      clearInterval(timer);
      timer = null;
    },
  };
};
