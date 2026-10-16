import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { ensureQuietWorkersLoaded, useQuietWorkersStore } from '@/stores/useQuietWorkersStore';

/**
 * Shows on a worker's row while it is set to "Orchestrator: quiet" (#156).
 * Only worker rows render it, so only they read the setting.
 */
export function QuietWorkerMarker({ sessionId }: { sessionId: string }): React.ReactNode {
  const quiet = useQuietWorkersStore((state) => state.quiet?.has(sessionId) ?? false);
  React.useEffect(ensureQuietWorkersLoaded, []);
  if (!quiet) return null;
  return (
    <span
      className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground"
      title={'Orchestrator: quiet'}
      data-testid="quiet-worker-marker"
    >
      <Icon name="eye-off" className="h-3 w-3" aria-label={'Orchestrator: quiet'} />
    </span>
  );
}
