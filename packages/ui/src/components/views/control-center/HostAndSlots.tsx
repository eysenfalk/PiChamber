import React from 'react';
import type { PiOrchestrationOverview } from '@/lib/pi/protocol';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { formatGiB } from './format';

type Props = {
  limit: PiOrchestrationOverview['limit'];
  host: PiOrchestrationOverview['host'];
};

/** Slot use and host load: the two numbers that decide whether another worker can start. */
export function HostAndSlots({ limit, host }: Props): React.ReactElement {
  const busy = host.load1 > host.cores;
  const full = limit.used >= limit.workerLimit;
  return (
    <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 typography-ui-label" aria-label="Slots and host">
      <div className="flex items-center gap-1.5">
        <Icon name="robot-2" className="size-4 text-muted-foreground" />
        <dt className="text-muted-foreground">{"Slots"}</dt>
        <dd className={cn('tabular-nums', full ? 'text-[var(--status-warning)]' : 'text-foreground')}>
          {`${limit.used} of ${limit.workerLimit} in use`}
        </dd>
      </div>
      <div className="flex items-center gap-1.5">
        <Icon name="server" className="size-4 text-muted-foreground" />
        <dt className="text-muted-foreground">{"Load"}</dt>
        <dd className={cn('tabular-nums', busy ? 'text-[var(--status-warning)]' : 'text-foreground')}>
          {`${host.load1.toFixed(2)} on ${host.cores === 1 ? '1 core' : `${host.cores} cores`}`}
        </dd>
      </div>
      <div className="flex items-center gap-1.5">
        <dt className="text-muted-foreground">{"Memory"}</dt>
        <dd className="tabular-nums text-foreground">{`${formatGiB(host.availableBytes)} free`}</dd>
      </div>
    </dl>
  );
}
