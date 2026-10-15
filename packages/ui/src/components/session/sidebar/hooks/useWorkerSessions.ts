import React from 'react';
import type { PiOrchestrationOverview } from '@/lib/pi/protocol';
import { acquireOverviewPolling, useOrchestrationOverviewStore } from '@/stores/useOrchestrationOverviewStore';

type WorkerSessions = {
  /** Every worker session in the orchestration registry, whatever its lifecycle; null until the registry was read. */
  workerIds: ReadonlySet<string> | null;
  /** Workers with an open question. */
  waitingIds: ReadonlySet<string>;
};

const joinSorted = (ids: string[]): string => ids.sort().join('\n');
const splitKey = (key: string): Set<string> => new Set(key ? key.split('\n') : []);

/** Worker ids as a stable key, so a poll that changes nothing does not rebuild the tree. Null before the first read. */
export const workerIdsKey = (overview: PiOrchestrationOverview | null): string | null => (
  overview
    ? joinSorted(overview.orchestrators.flatMap((group) => group.workers.map((worker) => worker.sessionId)))
    : null
);

export const waitingWorkerIdsKey = (overview: PiOrchestrationOverview | null): string => (
  overview
    ? joinSorted(overview.orchestrators.flatMap((group) => group.workers
      .filter((worker) => worker.question !== null)
      .map((worker) => worker.sessionId)))
    : ''
);

/**
 * Worker identity and open questions for the session list, from the orchestration
 * registry. Polls the overview only while `enabled` (the sidebar is shown); a
 * failed read keeps the last good overview, as the store does.
 */
export const useWorkerSessions = (enabled: boolean): WorkerSessions => {
  const workersKey = useOrchestrationOverviewStore((state) => workerIdsKey(state.overview));
  const waitingKey = useOrchestrationOverviewStore((state) => waitingWorkerIdsKey(state.overview));

  React.useEffect(() => (enabled ? acquireOverviewPolling() : undefined), [enabled]);

  const workerIds = React.useMemo(() => (workersKey === null ? null : splitKey(workersKey)), [workersKey]);
  const waitingIds = React.useMemo(() => splitKey(waitingKey), [waitingKey]);
  return { workerIds, waitingIds };
};
