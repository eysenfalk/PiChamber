import { DEFAULT_ORCHESTRATION_SETTINGS } from '../../settings-store.js';

// Wakes: the daemon tells an orchestrator in one short message that its
// workers finished a run, failed, asked or stalled, so it need not poll.
// Events live in memory only; a wake lost to a daemon restart is covered by
// the orchestrator reading `orchestration_digest` once after the restart.
//
// Events queue per worker. The owner is read from the registry when a batch
// is sent, so a takeover in between delivers to the new owner. An idle owner
// gets the batch `coalesceMs` after its first event; a busy one at its next
// settle. Entries leave the queue only after the send resolved, so events
// emitted during a send arrive with the next message.

export const EVENTS_MESSAGE = 'pichamber.orchestration.events';

const REASON_LIMIT = 200;
const WATCHDOG_TICK_MS = 15_000;
// Owner states that receive the batch at their next settle.
const BUSY_STATES = new Set(['busy', 'retry', 'starting']);
const DIGEST_HINT = 'Read `mcp__pichamber__orchestration_digest` for details.';

const oneLine = (text, fallback) => {
  const line = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  const value = line || fallback;
  return value.length > REASON_LIMIT ? `${value.slice(0, REASON_LIMIT - 1)}…` : value;
};

const isLiveWorker = (worker) => Boolean(worker) && !worker.stopping && worker.state !== 'stopped' && worker.state !== 'removed';

const formatBatch = (batch) => [
  `${batch.length === 1 ? 'A worker event' : `${batch.length} worker events`}:`,
  ...batch.map(({ title, event }) => `- ${title ? `"${title}" ` : ''}(${event.sessionId}) ${event.kind}: ${event.reason}`),
  DIGEST_HINT,
].join('\n');

/**
 * @param {object} deps the orchestration service's view of registry and sessions.
 */
export function createWakes({
  registry,
  getLiveRuntime,
  activateSession,
  holdSession,
  stateOf,
  runStartedAt,
  readSettings,
  now,
  isGone,
}) {
  // Worker sessionId -> events not yet delivered.
  const queues = new Map();
  // Owners with a send in flight; such an owner gets no second message.
  const sending = new Set();
  // Watchdog: the last message, tool or report activity per worker, and
  // the workers already reported stalled in the current episode.
  const lastActivity = new Map();
  const stalled = new Set();
  let timer;
  let scheduling = false;
  let interval;

  const settings = async () => {
    const value = await readSettings().catch(() => undefined);
    return {
      coalesceMs: value?.wakes?.coalesceMs ?? DEFAULT_ORCHESTRATION_SETTINGS.wakes.coalesceMs,
      stallAfterMs: value?.watchdog?.stallAfterMs ?? DEFAULT_ORCHESTRATION_SETTINGS.watchdog.stallAfterMs,
      watchdog: value?.watchdog?.enabled ?? DEFAULT_ORCHESTRATION_SETTINGS.watchdog.enabled,
    };
  };

  // One timer per burst: the first event arms it, later ones join the batch.
  const schedule = () => {
    if (timer !== undefined || scheduling) return;
    scheduling = true;
    void settings().then(({ coalesceMs }) => {
      scheduling = false;
      timer = setTimeout(() => {
        timer = undefined;
        void flush();
      }, coalesceMs);
      timer.unref?.();
    });
  };

  const emit = (sessionId, kind, reason) => {
    const queue = queues.get(sessionId) ?? [];
    queue.push({ sessionId, kind, reason: oneLine(reason, kind), at: now() });
    queues.set(sessionId, queue);
    schedule();
  };

  const forget = (events) => {
    for (const event of events) {
      const queue = queues.get(event.sessionId);
      if (!queue) continue;
      const rest = queue.filter((candidate) => candidate !== event);
      if (rest.length > 0) queues.set(event.sessionId, rest);
      else queues.delete(event.sessionId);
    }
  };

  const send = async (owner, cwd, batch) => {
    const events = batch.map((entry) => entry.event);
    const release = holdSession(owner);
    let delivered = false;
    try {
      const runtime = getLiveRuntime(owner) ?? await activateSession(owner, cwd);
      // With an idle owner Pi resolves this after the turn it starts.
      await runtime.session.sendCustomMessage({
        customType: EVENTS_MESSAGE,
        content: formatBatch(batch),
        display: true,
        details: { events },
      }, { triggerTurn: true, deliverAs: 'followUp' });
      forget(events);
      delivered = true;
    } catch (error) {
      // A deleted owner never takes them; anything else (SESSION_IN_USE, a
      // failed activation) keeps the queue for the next tick.
      if (isGone(error)) forget(events);
    } finally {
      release();
      sending.delete(owner);
    }
    // Events emitted during the send go out now; a kept queue waits for the
    // next tick or settle instead of retrying in a loop.
    if (delivered && queues.size > 0) void flush();
  };

  /** Sends every idle owner the events of its workers; a busy owner waits for its settle. */
  const flush = async () => {
    if (queues.size === 0) return;
    let document;
    try {
      document = await registry.read();
    } catch {
      return;
    }
    const byOwner = new Map();
    for (const [sessionId, events] of queues) {
      const worker = document.workers[sessionId];
      if (!isLiveWorker(worker)) {
        queues.delete(sessionId);
        continue;
      }
      const batch = byOwner.get(worker.orchestratorSessionId) ?? [];
      for (const event of events) batch.push({ title: worker.title, event });
      byOwner.set(worker.orchestratorSessionId, batch);
    }
    for (const [owner, batch] of byOwner) {
      if (sending.has(owner) || BUSY_STATES.has(stateOf(owner))) continue;
      sending.add(owner);
      void send(owner, document.owners[owner]?.cwd, batch);
    }
  };

  /** A message or tool event of a session: progress for the watchdog. */
  const touch = (sessionId) => {
    lastActivity.set(sessionId, now());
    stalled.delete(sessionId);
  };

  /** Any session settled: its stall episode ends, and as an owner it takes its batch. */
  const settled = (sessionId) => {
    lastActivity.delete(sessionId);
    stalled.delete(sessionId);
    if (queues.size > 0) void flush();
  };

  /** One watchdog pass over the registered workers, then a delivery attempt. */
  const tick = async () => {
    const { stallAfterMs, watchdog } = await settings();
    if (watchdog) {
      const { workers } = await registry.read();
      const at = now();
      for (const sessionId of lastActivity.keys()) {
        if (!workers[sessionId]) lastActivity.delete(sessionId);
      }
      for (const [sessionId, worker] of Object.entries(workers)) {
        if (!isLiveWorker(worker) || !BUSY_STATES.has(stateOf(sessionId))) {
          lastActivity.delete(sessionId);
          stalled.delete(sessionId);
          continue;
        }
        if (!lastActivity.has(sessionId)) lastActivity.set(sessionId, runStartedAt(sessionId) ?? at);
        const quietMs = at - lastActivity.get(sessionId);
        if (quietMs < stallAfterMs || stalled.has(sessionId)) continue;
        stalled.add(sessionId);
        emit(sessionId, 'stalled', `busy without a message, tool update or report for ${Math.floor(quietMs / 60_000)} min`);
      }
    }
    await flush();
  };

  const start = () => {
    if (interval) return;
    interval = setInterval(() => { void tick().catch(() => {}); }, WATCHDOG_TICK_MS);
    interval.unref?.();
  };

  const stop = () => {
    clearInterval(interval);
    clearTimeout(timer);
    interval = undefined;
    timer = undefined;
    queues.clear();
    lastActivity.clear();
    stalled.clear();
  };

  return { emit, touch, settled, tick, start, stop };
}
