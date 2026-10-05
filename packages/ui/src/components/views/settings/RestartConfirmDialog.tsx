import React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { catalogLiveSessionIdsKey } from '@/sync/pi-session-catalog';
import { getActiveSyncSessions } from '@/sync/sync-refs';
import { describeRestartConfirm, type WorkingSession } from './restartConfirm';

const workingHeading = (count: number): string => (
  count === 1 ? '1 session is working' : `${count} sessions are working`
);

/** Working sessions that a restart interrupts, or the plain statement that none is working. */
export function RestartWorkingSessions({ sessions }: { sessions: readonly WorkingSession[] }): React.ReactNode {
  if (sessions.length === 0) {
    return <p className="typography-ui-label text-muted-foreground">{'No session is working right now.'}</p>;
  }
  return (
    <section
      aria-live="polite"
      data-testid="restart-working-sessions"
      className="rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3"
    >
      <h3 className="typography-ui-label font-medium text-foreground">{workingHeading(sessions.length)}</h3>
      <p className="mt-1 typography-meta text-muted-foreground">
        {'Restarting interrupts running turns and subagents in these sessions.'}
      </p>
      <ul className="mt-2 max-h-40 list-disc space-y-1 overflow-y-auto pl-5 typography-meta text-foreground">
        {sessions.map((session) => (
          <li key={session.id}>{session.title ?? 'Untitled session'}</li>
        ))}
      </ul>
    </section>
  );
}

function RestartConfirmSessions({ open, children }: { open: boolean; children: (sessions: WorkingSession[]) => React.ReactNode }) {
  // The list follows the live catalog while the dialog is open, so a turn that
  // starts or ends after opening is reflected before the user confirms.
  const liveKey = usePiSessionSnapshot((state) => (open ? catalogLiveSessionIdsKey(state.catalog) : ''), undefined, 'catalog');
  const sessions = React.useMemo(() => {
    void liveKey;
    return open
      ? getActiveSyncSessions().sort((left, right) => (
          (left.title ?? '').localeCompare(right.title ?? '') || left.id.localeCompare(right.id)
        ))
      : [];
  }, [liveKey, open]);
  return <>{children(sessions)}</>;
}

export function RestartConfirmDialog(props: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): React.ReactNode {
  const { open, onCancel, onConfirm } = props;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent showCloseButton={false} className="max-w-md gap-5">
        <RestartConfirmSessions open={open}>
          {(sessions) => {
            const { confirmLabel, destructive } = describeRestartConfirm(sessions);
            return (
              <>
                <DialogHeader>
                  <DialogTitle>{'Restart PiChamber?'}</DialogTitle>
                  <DialogDescription>
                    {'PiChamber restarts its server and the Pi session daemon, or only the daemon when the server cannot restart itself. Connected devices reconnect on their own.'}
                  </DialogDescription>
                </DialogHeader>
                <RestartWorkingSessions sessions={sessions} />
                <DialogFooter>
                  <Button variant="outline" onClick={onCancel}>{'Cancel'}</Button>
                  <Button variant={destructive ? 'destructive' : 'default'} onClick={onConfirm}>{confirmLabel}</Button>
                </DialogFooter>
              </>
            );
          }}
        </RestartConfirmSessions>
      </DialogContent>
    </Dialog>
  );
}
