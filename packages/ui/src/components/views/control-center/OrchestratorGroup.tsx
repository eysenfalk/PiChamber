import React from 'react';
import type { PiOrchestrationOverviewGroup, PiOrchestrationWorker } from '@/lib/pi/protocol';
import { Icon } from '@/components/icon/Icon';
import { WorkerRow } from './WorkerRow';

type Props = {
  group: PiOrchestrationOverviewGroup;
  now: number;
  onOpenWorker: (worker: PiOrchestrationWorker) => void;
};

/** One orchestrator and the workers it started. */
export function OrchestratorGroup({ group, now, onOpenWorker }: Props): React.ReactElement {
  const title = group.title?.trim() || group.sessionId;
  const count = group.workers.length;
  return (
    <section aria-label={title} className="rounded-lg border border-border/60 bg-[var(--surface-elevated)]">
      <header className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border/40 px-3 py-2">
        <Icon name="node-tree" className="size-4 shrink-0 self-center text-muted-foreground" />
        <h2 className="min-w-0 truncate typography-ui-label font-semibold text-foreground">{title}</h2>
        <span className="shrink-0 typography-micro text-muted-foreground">
          {count === 1 ? '1 worker' : `${count} workers`}
        </span>
        {group.title === null ? (
          <span className="shrink-0 typography-micro text-muted-foreground/75">{"not running"}</span>
        ) : null}
        {!group.marked ? (
          <span className="shrink-0 typography-micro text-muted-foreground/75">{"no longer marked as orchestrator"}</span>
        ) : null}
      </header>
      {count === 0 ? (
        <p className="px-3 py-2 typography-micro text-muted-foreground">{"No workers."}</p>
      ) : (
        <ul className="divide-y divide-border/30 p-1">
          {group.workers.map((worker) => (
            <WorkerRow key={worker.sessionId} worker={worker} now={now} onOpen={onOpenWorker} />
          ))}
        </ul>
      )}
    </section>
  );
}
