import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { PiOrchestrationOverview } from '@/lib/pi/protocol';

let runtimeKey = 'runtime-a';
let reads = 0;
let next: () => Promise<PiOrchestrationOverview> = async () => overviewAt(1);
const overviewAt = (at: number) => ({ at, limit: { workerLimit: 4, used: 0 }, host: null, orchestrators: [], dialogs: [] }) as unknown as PiOrchestrationOverview;

let lastScope: unknown = null;
const getOrchestrationOverview = mock(async (scope?: { runtimeKey?: string }) => {
  reads += 1;
  lastScope = scope;
  return next();
});
mock.module('@/lib/pi/client', () => ({ piClient: { getOrchestrationOverview } }));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => runtimeKey,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));

const { useOrchestrationOverviewStore, acquireOverviewPolling } = await import('./useOrchestrationOverviewStore');
const store = () => useOrchestrationOverviewStore.getState();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const held = () => {
  let resolve!: (value: PiOrchestrationOverview) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<PiOrchestrationOverview>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('useOrchestrationOverviewStore', () => {
  beforeEach(() => {
    runtimeKey = 'runtime-a';
    reads = 0;
    next = async () => overviewAt(1);
    lastScope = null;
    store().reset('runtime-a');
  });

  test('stays empty until the first read, then shows it for its runtime', async () => {
    expect(store().overview).toBeNull();
    await store().refresh();
    expect(store().overview?.at).toBe(1);
    expect(store().error).toBeNull();
    expect(typeof store().fetchedAt).toBe('number');
    expect(lastScope).toEqual({ runtimeKey: 'runtime-a' });
  });

  test('a failed read keeps the last overview and marks it stale, never empty', async () => {
    await store().refresh();
    next = async () => { throw new Error('daemon down'); };
    await store().refresh();
    expect(store().overview?.at).toBe(1);
    expect(store().error).toBe('daemon down');
    next = async () => overviewAt(2);
    await store().refresh();
    expect(store().overview?.at).toBe(2);
    expect(store().error).toBeNull();
  });

  test('a first read that fails leaves no overview and an error', async () => {
    next = async () => { throw new Error('unreadable'); };
    await store().refresh();
    expect(store().overview).toBeNull();
    expect(store().error).toBe('unreadable');
  });

  test('callers share one read in flight', async () => {
    const gate = held();
    next = () => gate.promise;
    const first = store().refresh();
    const second = store().refresh();
    gate.resolve(overviewAt(3));
    await Promise.all([first, second]);
    expect(reads).toBe(1);
    expect(store().overview?.at).toBe(3);
  });

  test('drops an answer of the old runtime after a switch', async () => {
    await store().refresh();
    const gate = held();
    next = () => gate.promise;
    const old = store().refresh();
    runtimeKey = 'runtime-b';
    next = async () => overviewAt(5);
    await store().refresh();
    expect(store().runtimeKey).toBe('runtime-b');
    expect(store().overview?.at).toBe(5);
    gate.resolve(overviewAt(4));
    await old;
    expect(store().overview?.at).toBe(5);
  });

  test('a failure of the old runtime does not mark the new one stale', async () => {
    const gate = held();
    next = () => gate.promise;
    const old = store().refresh();
    store().reset('runtime-a');
    gate.reject(new Error('late'));
    await old;
    expect(store().error).toBeNull();
  });

  test('pauses while the window is hidden and reads again when it becomes visible', async () => {
    const listeners = new Set<() => void>();
    const fake = {
      visibilityState: 'visible',
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    };
    const previous = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = fake;
    try {
      const release = acquireOverviewPolling(10);
      await sleep(15);
      fake.visibilityState = 'hidden';
      listeners.forEach((listener) => listener());
      const whenHidden = reads;
      await sleep(40);
      expect(reads).toBe(whenHidden);
      fake.visibilityState = 'visible';
      listeners.forEach((listener) => listener());
      await sleep(5);
      expect(reads).toBeGreaterThan(whenHidden);
      release();
      expect(listeners.size).toBe(0);
    } finally {
      (globalThis as { document?: unknown }).document = previous;
    }
  });

  test('polls while held and stops when the last holder releases', async () => {
    const releaseA = acquireOverviewPolling(10);
    const releaseB = acquireOverviewPolling(10);
    await sleep(45);
    const whileHeld = reads;
    expect(whileHeld).toBeGreaterThanOrEqual(3);
    releaseA();
    releaseA();
    await sleep(25);
    expect(reads).toBeGreaterThan(whileHeld);
    releaseB();
    const afterRelease = reads;
    await sleep(40);
    expect(reads).toBe(afterRelease);
  });
});
