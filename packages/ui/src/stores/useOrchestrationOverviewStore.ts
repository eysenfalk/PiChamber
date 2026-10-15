import { useEffect } from 'react';
import { create } from 'zustand';
import { piClient } from '@/lib/pi/client';
import type { PiOrchestrationOverview } from '@/lib/pi/protocol';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

/**
 * The owner's control center data (#20): every orchestrator with its workers,
 * the slot use, the host and the pending dialogs, read from
 * `GET /api/pi/orchestration/overview`. The daemon is the authority; this
 * store only mirrors its last good answer for one runtime.
 *
 * - A failed read keeps the last good overview and sets `error`, so the view
 *   shows it as stale instead of an empty control center.
 * - `overview` stays `null` until the first read of this runtime succeeded.
 * - A runtime switch drops everything; an answer from the old runtime is
 *   discarded.
 * - It polls only while a consumer holds `acquireOverviewPolling` and the
 *   window is visible.
 */
interface OrchestrationOverviewState {
  overview: PiOrchestrationOverview | null;
  /** When the shown overview was read. */
  fetchedAt: number | null;
  /** The last read failed; a shown overview is stale. */
  error: string | null;
  runtimeKey: string;
  refresh: () => Promise<void>;
  reset: (runtimeKey?: string) => void;
}

const OVERVIEW_POLL_MS = 5_000;

// Bumped on every reset, so a read that started before it never commits.
let generation = 0;
let inFlight: { promise: Promise<void>; generation: number } | null = null;

export const useOrchestrationOverviewStore = create<OrchestrationOverviewState>((set, get) => ({
  overview: null,
  fetchedAt: null,
  error: null,
  runtimeKey: getRuntimeKey(),
  reset: (runtimeKey) => {
    generation += 1;
    inFlight = null;
    set({ overview: null, fetchedAt: null, error: null, runtimeKey: runtimeKey ?? getRuntimeKey() });
  },
  refresh: () => {
    const runtimeKey = getRuntimeKey();
    if (get().runtimeKey !== runtimeKey) get().reset(runtimeKey);
    if (inFlight && inFlight.generation === generation) return inFlight.promise;
    const started = generation;
    const current = () => started === generation && getRuntimeKey() === runtimeKey;
    const promise = piClient.getOrchestrationOverview({ runtimeKey }).then(
      (overview) => {
        if (current()) set({ overview, fetchedAt: Date.now(), error: null });
      },
      (error: unknown) => {
        if (current()) set({ error: error instanceof Error ? error.message : 'The overview could not be read' });
      },
    );
    const entry = { promise, generation: started };
    inFlight = entry;
    const release = () => { if (inFlight === entry) inFlight = null; };
    void promise.then(release);
    return promise;
  },
}));

if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged((detail) => {
    useOrchestrationOverviewStore.getState().reset(detail.runtimeKey);
  });
}

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

let consumers = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let pollMs = OVERVIEW_POLL_MS;

const stopTimer = () => {
  if (timer !== null) clearTimeout(timer);
  timer = null;
};

// One read at a time: the next one is scheduled after the last one settled.
const tick = async () => {
  stopTimer();
  if (consumers === 0 || hidden()) return;
  await useOrchestrationOverviewStore.getState().refresh();
  if (consumers > 0 && timer === null && !hidden()) timer = setTimeout(() => void tick(), pollMs);
};

const onVisibility = () => {
  if (hidden()) stopTimer();
  else void tick();
};

/** Reads now and every `intervalMs` while the window is visible; call the result to stop. */
export const acquireOverviewPolling = (intervalMs = OVERVIEW_POLL_MS): (() => void) => {
  consumers += 1;
  pollMs = intervalMs;
  if (consumers === 1 && typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  void tick();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    consumers -= 1;
    if (consumers > 0) return;
    stopTimer();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  };
};

/** Keeps the overview fresh while the calling component is mounted. */
export const useOrchestrationOverviewPolling = (): void => {
  useEffect(() => acquireOverviewPolling(), []);
};
