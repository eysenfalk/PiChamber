import React from 'react';
import { acquireOverviewPolling, useOrchestrationOverviewStore } from '@/stores/useOrchestrationOverviewStore';
import { countOpenDecisions } from './decisionInboxModel';

/**
 * The number of decisions waiting for the owner (open owner questions and
 * pending dialogs) for the control center entry in the header and the mobile
 * navigation. Holds the overview polling while mounted, so the count stays
 * current without the view open; null until the first overview was read, so
 * a failed or missing read never shows as zero.
 */
export const useDecisionInboxCount = (): number | null => {
  React.useEffect(() => acquireOverviewPolling(), []);
  return useOrchestrationOverviewStore((state) => (state.overview ? countOpenDecisions(state.overview) : null));
};

/** The accessible name of the control center entry, with the count when there is one. */
export const controlCenterEntryLabel = (open: boolean, count: number | null): string => {
  const base = open ? 'Close control center' : 'Open control center';
  if (!count) return base;
  return count === 1 ? `${base}, 1 decision waiting` : `${base}, ${count} decisions waiting`;
};
