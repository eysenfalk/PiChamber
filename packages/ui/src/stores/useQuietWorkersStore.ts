import { create } from 'zustand';
import { piClient } from '@/lib/pi/client';
import { getRuntimeKey } from '@/lib/runtime-switch';

/**
 * Which workers are set to "Orchestrator: quiet" (#156). The ids live in the
 * Pi settings file and the daemon enforces the rule; this store only mirrors
 * them for the session rows and the row menu, and a failed read leaves the
 * state unknown (`null`) instead of passing for "nobody is quiet".
 */
interface QuietWorkersState {
  quiet: ReadonlySet<string> | null;
  runtimeKey: string | null;
  load: () => Promise<void>;
  setQuiet: (sessionId: string, quiet: boolean) => Promise<void>;
}

// Reads are numbered by start. A response is dropped when a newer read was
// applied or a change finished after the read started, so an old answer never
// hides a newer state. Rows that load at the same time share one read.
let lastStarted = 0;
let lastApplied = 0;
let floor = 0;
let shared: { promise: Promise<void>; floor: number; runtimeKey: string } | null = null;

export const useQuietWorkersStore = create<QuietWorkersState>((set, get) => ({
  quiet: null,
  runtimeKey: null,
  load: () => {
    const runtimeKey = getRuntimeKey();
    // Another host needs its own read: the old one fails when the runtime changed.
    if (shared && shared.floor === floor && shared.runtimeKey === runtimeKey) return shared.promise;
    const seq = ++lastStarted;
    const read = piClient.getSettings({ runtimeKey }).then((settings) => {
      if (seq < lastApplied || seq < floor) return;
      lastApplied = seq;
      set({ quiet: new Set(settings.orchestration.quietWorkers), runtimeKey });
    });
    const entry = { promise: read, floor, runtimeKey };
    shared = entry;
    const release = () => { if (shared === entry) shared = null; };
    read.then(release, release);
    return read;
  },
  setQuiet: async (sessionId, quiet) => {
    await piClient.setPiChamberDefaults(
      { orchestration: { quietWorkers: { [sessionId]: quiet ? true : null } } },
      { runtimeKey: getRuntimeKey() },
    );
    // Reads that started before this change are stale from now on.
    floor = lastStarted + 1;
    // The file is the authority: read the list back instead of patching it.
    await get().load();
  },
}));

/** Loads the ids once per runtime; the rows of workers call it, others never do. */
export const ensureQuietWorkersLoaded = (): void => {
  const state = useQuietWorkersStore.getState();
  if (state.quiet !== null && state.runtimeKey === getRuntimeKey()) return;
  void state.load().catch(() => undefined);
};
