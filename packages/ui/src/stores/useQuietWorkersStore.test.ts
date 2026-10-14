import { beforeEach, describe, expect, mock, test } from 'bun:test';

let stored: string[] = [];
let failRead = false;
const updates: unknown[] = [];

const getSettings = mock(async () => {
  if (failRead) throw new Error('offline');
  return { orchestration: { quietWorkers: [...stored] } };
});
const setPiChamberDefaults = mock(async (input: { orchestration: { quietWorkers: Record<string, true | null> } }) => {
  updates.push(input);
  for (const [id, value] of Object.entries(input.orchestration.quietWorkers)) {
    stored = stored.filter((entry) => entry !== id);
    if (value) stored.push(id);
  }
});

mock.module('@/lib/pi/client', () => ({ piClient: { getSettings, setPiChamberDefaults } }));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => 'runtime-a' }));

const { useQuietWorkersStore } = await import('./useQuietWorkersStore');

describe('useQuietWorkersStore', () => {
  beforeEach(() => {
    stored = [];
    failRead = false;
    updates.length = 0;
    useQuietWorkersStore.setState({ quiet: null, runtimeKey: null });
  });

  test('stays unknown until the settings were read, and a failed read does not pass for nobody quiet', async () => {
    failRead = true;
    await expect(useQuietWorkersStore.getState().load()).rejects.toThrow('offline');
    expect(useQuietWorkersStore.getState().quiet).toBeNull();
  });

  test('reads the quiet workers from the settings', async () => {
    stored = ['worker-1'];
    await useQuietWorkersStore.getState().load();
    expect(useQuietWorkersStore.getState().quiet?.has('worker-1')).toBe(true);
    expect(useQuietWorkersStore.getState().quiet?.has('worker-2')).toBe(false);
  });

  test('sets a worker quiet with true, makes it follow again with null, and shows what the file holds', async () => {
    await useQuietWorkersStore.getState().setQuiet('worker-1', true);
    expect(updates[0]).toEqual({ orchestration: { quietWorkers: { 'worker-1': true } } });
    expect(useQuietWorkersStore.getState().quiet?.has('worker-1')).toBe(true);

    await useQuietWorkersStore.getState().setQuiet('worker-1', false);
    expect(updates[1]).toEqual({ orchestration: { quietWorkers: { 'worker-1': null } } });
    expect(useQuietWorkersStore.getState().quiet?.has('worker-1')).toBe(false);
  });
});
