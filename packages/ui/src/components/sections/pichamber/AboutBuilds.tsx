import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  describeBuildMismatch,
  findBuildMismatch,
  formatBuildTime,
  type BuildMismatch,
  type RuntimeBuilds,
} from '@/lib/build-info';
import { cn } from '@/lib/utils';

type BuildRow = {
  key: 'ui' | 'server' | 'daemon';
  label: string;
  id: string | null;
  timeLabel: string;
  at: string | undefined;
};

const MISMATCHED_ROW: Record<BuildMismatch, BuildRow['key']> = {
  'ui-newer-than-server': 'ui',
  'ui-older-than-server': 'ui',
  'daemon-older-than-server': 'daemon',
  'daemon-differs-from-server': 'daemon',
};

const buildRows = ({ ui, server, daemon }: RuntimeBuilds): BuildRow[] => [
  { key: 'ui', label: 'UI', id: ui?.id ?? null, timeLabel: 'built', at: ui?.builtAt },
  {
    key: 'server',
    label: 'Server',
    id: server?.id ?? null,
    // A source checkout has no build; its time is when the server started.
    timeLabel: server?.kind === 'source' ? 'started' : 'built',
    at: server?.builtAt,
  },
  { key: 'daemon', label: 'Session daemon', id: daemon?.id ?? null, timeLabel: 'built', at: daemon?.builtAt },
];

/** UI, server and session daemon build, each with ID and local date and time; a mismatch is marked with a restart hint. */
export function AboutBuilds({ builds, locale }: { builds: RuntimeBuilds; locale?: string }): React.ReactNode {
  const mismatch = findBuildMismatch(builds);
  const mismatchedKey = mismatch ? MISMATCHED_ROW[mismatch] : null;
  return (
    <div className="flex min-w-0 flex-col gap-2 typography-meta" data-testid="about-builds">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {buildRows(builds).map((row) => (
          <React.Fragment key={row.key}>
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd
              data-build-row={row.key}
              data-build-mismatch={row.key === mismatchedKey ? 'true' : undefined}
              className={cn(
                'flex min-w-0 flex-wrap items-center gap-x-2 text-foreground',
                row.key === mismatchedKey && 'text-[var(--status-warning)]',
              )}
            >
              {row.id ? (
                <>
                  <span className="font-mono">{row.id}</span>
                  <span className="text-muted-foreground">{`${row.timeLabel} ${formatBuildTime(row.at, locale)}`}</span>
                </>
              ) : (
                <span className="text-muted-foreground">{'Not available'}</span>
              )}
              {row.key === mismatchedKey ? (
                <span className="rounded px-1 typography-micro bg-[var(--status-warning-background)] text-foreground">{'Differs'}</span>
              ) : null}
            </dd>
          </React.Fragment>
        ))}
      </dl>
      {mismatch ? (
        <p role="status" data-testid="about-build-mismatch" className="flex items-start gap-1.5 text-foreground">
          <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" aria-hidden="true" />
          <span>{describeBuildMismatch(mismatch)}</span>
        </p>
      ) : null}
    </div>
  );
}
