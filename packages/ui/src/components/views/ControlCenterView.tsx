import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useOrchestrationOverviewPolling, useOrchestrationOverviewStore } from '@/stores/useOrchestrationOverviewStore';
import { HostAndSlots } from './control-center/HostAndSlots';
import { OrchestratorGroup } from './control-center/OrchestratorGroup';
import { formatClock } from './control-center/format';
import { openWorkerSession } from './control-center/openWorkerSession';

/**
 * The owner's control center (#20): every orchestrator with its workers, the
 * slot use and the host load. The overview store is the only data source and
 * polls while this view is mounted.
 */
export function ControlCenterView(): React.ReactElement {
  useOrchestrationOverviewPolling();
  const overview = useOrchestrationOverviewStore((state) => state.overview);
  const error = useOrchestrationOverviewStore((state) => state.error);
  const fetchedAt = useOrchestrationOverviewStore((state) => state.fetchedAt);
  const refresh = useOrchestrationOverviewStore((state) => state.refresh);
  const retry = React.useCallback(() => { void refresh(); }, [refresh]);

  if (!overview) {
    if (error === null) {
      return (
        <div className="flex h-full items-center justify-center gap-2 p-4 typography-ui-label text-muted-foreground" role="status">
          <Icon name="loader-4" className="size-4 animate-spin" />
          {"Loading the control center"}
        </div>
      );
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center" role="alert">
        <p className="flex items-center gap-2 typography-ui-label text-foreground">
          <Icon name="error-warning" className="size-4 text-[var(--status-error)]" />
          {"The control center could not be loaded"}
        </p>
        <p className="max-w-md typography-micro text-muted-foreground">{error}</p>
        <button
          type="button"
          onClick={retry}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <Icon name="refresh" className="size-4" />
          {"Retry"}
        </button>
      </div>
    );
  }

  const now = overview.at;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-4 max-[640px]:px-3">
        <div className="flex flex-col gap-2">
          <HostAndSlots limit={overview.limit} host={overview.host} />
          {error ? (
            <p className="flex items-center gap-1.5 typography-micro text-foreground" role="status">
              <Icon name="error-warning" className="size-3.5 text-[var(--status-warning)]" />
              {fetchedAt !== null
                ? `Stale: last read at ${formatClock(fetchedAt)}. ${error}`
                : `Stale. ${error}`}
              <button
                type="button"
                onClick={retry}
                className="ml-1 rounded-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                {"Retry"}
              </button>
            </p>
          ) : null}
        </div>

        {/* S7 places the decision inbox here, above the workers. */}

        {overview.orchestrators.length === 0 ? (
          <div className="py-10 text-center text-muted-foreground">
            <p className="typography-ui-label font-semibold">{"No orchestrators"}</p>
            <p className="mt-1 typography-micro">{"Workers appear here once an orchestrator session starts them."}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3" aria-label="Workers by orchestrator">
            {overview.orchestrators.map((group) => (
              <OrchestratorGroup key={group.sessionId} group={group} now={now} onOpenWorker={openWorkerSession} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
