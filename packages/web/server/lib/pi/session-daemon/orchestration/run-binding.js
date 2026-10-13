// Binds an input's verdict to the run Pi started for it, so a later abort
// hits that run and no other. SDK assumption (Pi 1.1.0, CONTEXT.md): Pi
// calls `preflightResult('started')` and then, without an await in between,
// starts the run (`Agent.runWithLifecycle`), whose own AbortSignal is
// `session.agent.signal` until the run ends. A signal that is new one
// microtask after the callback is therefore this prompt's run; the same
// signal as before means the prompt started no run of its own. The real-SDK
// test in `admission.e2e.test.js` pins this order.

/** Called synchronously in `preflightResult('started')`; resolves to the run's signal or null. */
export const bindStartedRun = (session) => {
  const before = session?.agent?.signal;
  return new Promise((resolve) => {
    queueMicrotask(() => {
      const after = session?.agent?.signal;
      resolve(after && after !== before ? after : null);
    });
  });
};

/**
 * Aborts the run that `signal` belongs to while it is the session's run;
 * check and abort happen in one synchronous step. Returns whether it aborted.
 */
export const abortBoundRun = (session, signal) => {
  if (!signal || signal.aborted || session?.agent?.signal !== signal) return false;
  void session.abort().catch(() => {});
  return true;
};
