import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Identity of the daemon process that drives a transitional registry record.
// Several daemons can share one data root, and several services can live in
// one process (per-profile daemons, tests), so the instance is per process,
// not per service. A pid alone outlives its process: after a restart the
// same pid can belong to another program or to the new daemon itself.

export const PROCESS_INSTANCE = randomUUID();

/** Kernel start time of `pid` in clock ticks (Linux), or null when unknown. */
export const readProcessStartTime = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 2 (comm) may contain spaces and parentheses; fields resume after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const startTime = Number(fields[19]);
    return Number.isFinite(startTime) ? startTime : null;
  } catch {
    return null;
  }
};

// Signal 0 probes a pid without touching it; EPERM means it exists.
export const isPidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

/**
 * The stamp of this process and a check whether a recorded stamp still names
 * a live process. A dead pid is dead; a live pid whose start time differs
 * from the recorded one is a reused pid, so the recorded process is dead.
 * Without a start time on either side the pid is taken as alive: holding a
 * slot too long is safe, releasing a live one is not.
 */
export const createProcessIdentity = ({
  pid = process.pid,
  instance = PROCESS_INSTANCE,
  isAlive = isPidAlive,
  startTimeOf = readProcessStartTime,
} = {}) => {
  const startedAt = startTimeOf(pid);
  // `service` tells apart several services in one process.
  const self = { pid, instance, service: randomUUID(), ...(startedAt !== null ? { startedAt } : {}) };
  const isLive = (owner) => {
    if (!owner) return false;
    if (owner.instance === instance) return true;
    if (!isAlive(owner.pid)) return false;
    const current = startTimeOf(owner.pid);
    if (Number.isFinite(owner.startedAt) && current !== null) return current === owner.startedAt;
    return true;
  };
  const isMine = (owner) => owner?.instance === instance && owner?.service === self.service;
  return { self, isLive, isMine };
};
