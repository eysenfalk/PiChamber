import { SUBAGENT_ASYNC_STATUS_LINE_PREFIX } from '../extension-protocol.js';

// The run states of version 1 of the pi-subagents async status snapshot
// (`AsyncStatusSnapshotState` in its async-status-projection.ts) that still
// have work ahead: a queued run has not started, a running one has not ended.
// complete, failed, partial, paused, stopped and rejected are not live.
const SNAPSHOT_KIND = 'pi-subagents.async-status-snapshot';
const SNAPSHOT_VERSION = 1;
const LIVE_RUN_STATES = new Set(['queued', 'running']);

/**
 * True when the widget lines are an async status snapshot with at least one
 * top-level run that is queued or running. Anything that does not parse as a
 * version 1 snapshot is not live, and this never throws: the caller uses it to
 * keep a session resident, so a malformed line must never hold one.
 */
export const hasLiveSubagentRuns = (lines) => {
  try {
    const line = Array.isArray(lines) ? lines[0] : undefined;
    if (typeof line !== 'string' || !line.startsWith(SUBAGENT_ASYNC_STATUS_LINE_PREFIX)) return false;
    const snapshot = JSON.parse(line.slice(SUBAGENT_ASYNC_STATUS_LINE_PREFIX.length));
    if (snapshot?.kind !== SNAPSHOT_KIND || snapshot.version !== SNAPSHOT_VERSION) return false;
    if (!Array.isArray(snapshot.runs)) return false;
    return snapshot.runs.some((run) => typeof run?.state === 'string' && LIVE_RUN_STATES.has(run.state));
  } catch {
    return false;
  }
};
