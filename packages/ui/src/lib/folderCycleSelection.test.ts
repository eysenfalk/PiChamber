import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ProjectEntry } from '@/lib/api/types';

// The sidebar tree selection must follow Ctrl+Shift+F. These tests drive the
// real cycle action and assert it moves the selection without opening a session.
const setCurrentSessionCalls: Array<{ id: string | null; directory: string | null }> = [];
const openNewSessionDraftCalls: Array<unknown> = [];
const closeMainSurfacesCalls: number[] = [];

mock.module('@/sync/sync-refs', () => ({
  getSyncSessions: () => [
    { id: 'session-b', directory: '/repo-b' },
  ],
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      setCurrentSession: (id: string | null, directory: string | null) => {
        setCurrentSessionCalls.push({ id, directory });
      },
      openNewSessionDraft: (options: unknown) => {
        openNewSessionDraftCalls.push(options);
      },
    }),
  },
}));

mock.module('@/stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({
      closeMainSurfaces: () => {
        closeMainSurfacesCalls.push(1);
      },
    }),
  },
}));

const { cycleSessionFolder } = await import('./folderCycle');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useSidebarSpaceStore } = await import('@/stores/useSidebarSpaceStore');

const projectA = {
  id: 'project-a',
  path: '/repo-a',
  label: 'Repo A',
  lastOpenedAt: 100,
} as ProjectEntry;
const projectB = {
  id: 'project-b',
  path: '/repo-b',
  label: 'Repo B',
  lastOpenedAt: 200,
} as ProjectEntry;

beforeEach(() => {
  setCurrentSessionCalls.length = 0;
  openNewSessionDraftCalls.length = 0;
  closeMainSurfacesCalls.length = 0;
  useProjectsStore.setState({
    projects: [projectA, projectB],
    activeProjectId: projectA.id,
    manualProjectOrder: [projectA.id, projectB.id],
  });
  useSidebarSpaceStore.setState({ selectedNodeKey: 'w:/repo-a/wt-1' });
});

const expectNoSessionOpened = () => {
  expect(setCurrentSessionCalls).toEqual([]);
  expect(openNewSessionDraftCalls).toEqual([]);
  expect(closeMainSurfacesCalls).toEqual([]);
};

describe('cycleSessionFolder sidebar selection', () => {
  test('moves the tree selection to the cycled project and opens no session', () => {
    expect(cycleSessionFolder()).toBe(true);

    expect(useProjectsStore.getState().activeProjectId).toBe(projectB.id);
    expect(useSidebarSpaceStore.getState().selectedNodeKey).toBe(`p:${projectB.id}`);
    expectNoSessionOpened();
  });

  test('cycles backward for the application menu previous-project action', () => {
    useProjectsStore.setState({ activeProjectId: projectB.id });
    useSidebarSpaceStore.setState({ selectedNodeKey: `p:${projectB.id}` });

    expect(cycleSessionFolder(-1)).toBe(true);

    expect(useProjectsStore.getState().activeProjectId).toBe(projectA.id);
    expect(useSidebarSpaceStore.getState().selectedNodeKey).toBe(`p:${projectA.id}`);
    expectNoSessionOpened();
  });

  test('leaves the selection alone when there is nothing to cycle', () => {
    useProjectsStore.setState({
      projects: [projectA],
      activeProjectId: projectA.id,
      manualProjectOrder: [projectA.id],
    });

    expect(cycleSessionFolder()).toBe(false);

    expect(useSidebarSpaceStore.getState().selectedNodeKey).toBe('w:/repo-a/wt-1');
  });
});
