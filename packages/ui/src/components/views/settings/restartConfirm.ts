export type WorkingSession = {
  id: string;
  title: string | null;
  directory: string;
};

export const describeRestartConfirm = (sessions: readonly WorkingSession[]): { confirmLabel: string; destructive: boolean } => (
  sessions.length > 0
    ? { confirmLabel: 'Interrupt and restart', destructive: true }
    : { confirmLabel: 'Restart PiChamber', destructive: false }
);
