import { beforeEach, describe, expect, test } from 'bun:test';
import type { GitStatus } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGitStore, type GitAPI } from '@/stores/useGitStore';
import { fetchLightWorktreeStatus } from './useWorktreeStatusScheduler';

const status = (overrides: Partial<GitStatus> = {}): GitStatus => ({
  current: 'feature',
  tracking: 'origin/feature',
  ahead: 1,
  behind: 0,
  files: [{ path: 'a.ts', index: ' ', working_dir: 'M' }],
  isClean: false,
  ...overrides,
});

const createGitApi = (overrides: Partial<GitAPI> = {}): GitAPI => ({
  checkIsGitRepository: async () => true,
  getGitStatus: async () => status(),
  getGitBranches: async () => ({ all: [], current: 'main', branches: {} }),
  getGitLog: async () => ({ all: [], latest: null, total: 0 }),
  getGitFileDiff: async (_directory, options) => ({ original: '', modified: '', path: options.path }),
  ...overrides,
});

describe('fetchLightWorktreeStatus', () => {
  beforeEach(() => {
    useGitStore.getState().resetForRuntimeSwitch(getRuntimeKey());
  });

  test('requests the light status and returns what useGitStore cached', async () => {
    const modes: Array<'light' | undefined> = [];
    const git = createGitApi({
      getGitStatus: async (_directory, options) => {
        modes.push(options?.mode);
        return status({ ahead: 4 });
      },
    });

    const result = await fetchLightWorktreeStatus('/repo-a', git);

    expect(modes).toEqual(['light']);
    expect(result?.ahead).toBe(4);
    expect(useGitStore.getState().getDirectoryState('/repo-a')?.status).toBe(result);
  });

  test('a directory that is not a git repository resolves to null', async () => {
    const git = createGitApi({ checkIsGitRepository: async () => false });
    expect(await fetchLightWorktreeStatus('/not-a-repo', git)).toBeNull();
  });

  test('a failed request rejects instead of returning an empty or earlier status', async () => {
    const git = createGitApi();
    await fetchLightWorktreeStatus('/repo-b', git);

    const failing = createGitApi({
      getGitStatus: async () => {
        throw new Error('git exploded');
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 2));

    await expect(fetchLightWorktreeStatus('/repo-b', failing)).rejects.toThrow('Git status request did not complete');
    // The earlier cached status stays in the store for other consumers.
    expect(useGitStore.getState().getDirectoryState('/repo-b')?.status?.current).toBe('feature');
  });
});
