// Binds an input's verdict to the run Pi started for it, so a later abort
// hits that run and no other. SDK assumption (Pi 1.1.0, CONTEXT.md): Pi
// calls `preflightResult('started')` and then, without an await in between,
// starts the run (`Agent.runWithLifecycle`), whose own AbortSignal is
// `session.agent.signal` until the run ends. A signal that is new one
// microtask after the callback is therefore this prompt's run; the same
// signal as before means the prompt started no run of its own. The real-SDK
// test in `run-binding.e2e.test.js` pins this order.

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
 * Proof that the run `run` (from `bindStartedRun`) ended, from the prompt that
 * started it. SDK assumption (Pi 1.1.0, CONTEXT.md): `prompt()` resolves only
 * after its run, every retry and continuation of it, and its `agent_settled`
 * handlers; a prompt deferred while the previous run settles resolves early,
 * but gives no `started` verdict then. Resolves true once `promptEnd`
 * resolved and the run's signal is no longer the session's; false while that
 * signal is still live (the prompt resolved before its run ended).
 */
export const provenRunEnd = async (session, promptEnd, run) => {
  const signal = await run;
  await promptEnd;
  return !signal || session?.agent?.signal !== signal;
};

/**
 * Whether an `agent_settled` event is a real completion. SDK assumption (Pi
 * 1.1.0, CONTEXT.md): a run's signal is `session.agent.signal` from its start
 * until the run ends, also when it is aborted, and every continuation makes a
 * new one; Pi emits `agent_settled` after the run ended. A signal that still
 * exists means a run is live, so that settle completes nothing. Between a
 * failed attempt and its retry there is no signal, but `session.isRetrying`
 * holds (R9-B1): a settle of another prompt then completes nothing either.
 * Elsewhere a missing signal is no proof of an end (the release waits for the
 * run's own prompt, `provenRunEnd`); this check only keeps the native idle
 * and result boundary from firing for a run that is known to go on.
 */
export const isSettleFinal = (session) => session?.agent?.signal === undefined && !session?.isRetrying;

/**
 * Aborts the run that `signal` belongs to while it is the session's run;
 * check and abort happen in one synchronous step. Returns whether it aborted.
 */
export const abortBoundRun = (session, signal) => {
  if (!signal || signal.aborted || session?.agent?.signal !== signal) return false;
  void session.abort().catch(() => {});
  return true;
};
