import { beforeEach, describe, expect, mock, test } from 'bun:test';

const calls: string[] = [];

mock.module('@/stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({
      closeMainSurfaces: () => { calls.push('closeMainSurfaces'); },
      setActiveMainTab: (tab: string) => { calls.push(`tab:${tab}`); },
    }),
  },
}));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      setCurrentSession: (id: string, directory: string | null) => { calls.push(`session:${id}:${directory}`); },
    }),
  },
}));

const { openWorkerSession } = await import('./openWorkerSession');

describe('openWorkerSession', () => {
  beforeEach(() => { calls.length = 0; });

  test('leaves the control center for the chat and selects the worker in its worktree', () => {
    openWorkerSession({ sessionId: 'worker-1', worktree: '/wt/7-fix' });
    expect(calls).toEqual(['closeMainSurfaces', 'tab:chat', 'session:worker-1:/wt/7-fix']);
  });

  test('a worker without a known worktree opens without a directory hint', () => {
    openWorkerSession({ sessionId: 'worker-2', worktree: null });
    expect(calls).toEqual(['closeMainSurfaces', 'tab:chat', 'session:worker-2:null']);
  });
});
