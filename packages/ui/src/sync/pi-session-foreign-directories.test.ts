import { afterEach, describe, expect, test } from 'bun:test';

import { PiSessionStore } from '@/apps/pi-session-store';
import { piClient, PiRequestError } from '@/lib/pi/client';
import { createPiSessionCatalogCache, type PiSessionCatalogCache } from '@/sync/pi-session-catalog-cache';

// Issue #103: a session started in a folder outside every project never
// reached the sidebar, because the catalog only listed known directories.

const PROJECT = '/workspace/project';
const SCRATCH = '/lab/folders/scratch';
const NOTES = '/lab/folders/notes';

const createMemoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as Storage;
};

const listed = (id: string, directory: string) => ({
  session: { id, directory, title: id, parentId: null, createdAt: 1, updatedAt: 2, messageCount: 1 },
  updatedAt: 2,
});

const caches: PiSessionCatalogCache[] = [];
const restoreFns: Array<() => void> = [];
afterEach(() => {
  while (restoreFns.length > 0) restoreFns.pop()!();
  for (const cache of caches.splice(0)) cache.dispose();
});

const createStore = () => {
  const cache = createPiSessionCatalogCache(createMemoryStorage(), { flushDelayMs: 0 });
  caches.push(cache);
  const store = new PiSessionStore(cache);
  restoreFns.push(() => store.dispose());
  return store;
};

const stubClient = (answers: {
  directories: () => Promise<Awaited<ReturnType<typeof piClient.listSessionDirectories>>>;
}) => {
  const listedDirectories: string[] = [];
  const originalDirectories = piClient.listSessionDirectories;
  const originalSessions = piClient.listSessions;
  piClient.listSessionDirectories = (async () => answers.directories()) as typeof piClient.listSessionDirectories;
  piClient.listSessions = (async (scope?: { directory?: string }) => {
    const directory = scope?.directory ?? '';
    listedDirectories.push(directory);
    return { sessions: [listed(`session-in-${directory}`, directory)] };
  }) as typeof piClient.listSessions;
  restoreFns.push(() => {
    piClient.listSessionDirectories = originalDirectories;
    piClient.listSessions = originalSessions;
  });
  return listedDirectories;
};

describe('PiSessionStore.refreshForeignSessionDirectories', () => {
  test('learns and lists the folders outside every known directory', async () => {
    const listedDirectories = stubClient({
      directories: async () => ({ directories: ['/Workspace/Project', SCRATCH, '/home/user'] }),
    });
    const store = createStore();

    await store.refreshForeignSessionDirectories([PROJECT, '/home/user']);

    expect(store.getState().foreignSessionDirectories).toEqual([SCRATCH]);
    expect(listedDirectories).toEqual([SCRATCH]);
    expect(store.getState().catalog.byId.has(`session-in-${SCRATCH}`)).toBe(true);
    expect(store.getState().catalog.listStatusByDirectory.get(SCRATCH)).toBe('ready');
  });

  test('a failed answer keeps the learned folders and their sessions', async () => {
    let fail = false;
    stubClient({
      directories: async () => {
        if (fail) throw new PiRequestError('DAEMON_UNAVAILABLE', 'offline');
        return { directories: [SCRATCH] };
      },
    });
    const store = createStore();
    await store.refreshForeignSessionDirectories([PROJECT]);

    fail = true;
    await store.refreshForeignSessionDirectories([PROJECT]);

    expect(store.getState().foreignSessionDirectories).toEqual([SCRATCH]);
    expect(store.getState().catalog.byId.has(`session-in-${SCRATCH}`)).toBe(true);
  });

  test('an incomplete answer only adds folders; a complete one replaces them', async () => {
    let answer: Awaited<ReturnType<typeof piClient.listSessionDirectories>> = { directories: [SCRATCH] };
    stubClient({ directories: async () => answer });
    const store = createStore();
    await store.refreshForeignSessionDirectories([PROJECT]);

    answer = { directories: [NOTES], incomplete: true };
    await store.refreshForeignSessionDirectories([PROJECT]);
    expect(store.getState().foreignSessionDirectories).toEqual([SCRATCH, NOTES]);

    answer = { directories: [NOTES] };
    await store.refreshForeignSessionDirectories([PROJECT]);
    expect(store.getState().foreignSessionDirectories).toEqual([NOTES]);
  });

  test('a folder that became known stops being foreign', async () => {
    stubClient({ directories: async () => ({ directories: [SCRATCH] }) });
    const store = createStore();
    await store.refreshForeignSessionDirectories([PROJECT]);

    await store.refreshForeignSessionDirectories([PROJECT, SCRATCH]);

    expect(store.getState().foreignSessionDirectories).toEqual([]);
  });
});
