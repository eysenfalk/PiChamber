import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/chat/types';

import { getPiSessionStore, type PiSessionStore } from '@/apps/pi-session-store';
import { initialCatalog, type LiveSessionRecord } from '@/sync/pi-session-catalog';
import { useSidebarSessions } from './useSidebarSessions';

// Issue #160: a worker session ran in a worktree that was removed and then
// recreated at the same path. While the worktree was gone, Git discovery no
// longer listed it, so the sidebar's known directory set lost that path.
// The session still existed and ran; it must come back with its worktree.

const PROJECT = '/repo';
const WORKTREE = '/worktrees/review-157';

const installMinimalDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  class ElementStub {}
  const documentStub: Record<string, unknown> = {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const container = {
    nodeType: 1,
    tagName: 'DIV',
    nodeName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: documentStub,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  documentStub.documentElement = container;
  documentStub.body = container;
  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return {
    container: container as unknown as Element,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const record = (id: string, directory: string, overrides: Partial<LiveSessionRecord> = {}): LiveSessionRecord => ({
  id,
  directory,
  parentId: null,
  title: id,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  lifecycle: 'idle',
  hydrated: false,
  ...overrides,
});

const seedCatalog = (store: PiSessionStore, records: LiveSessionRecord[]) => {
  const byDirectory = new Map<string, string[]>();
  for (const entry of records) {
    byDirectory.set(entry.directory, [...(byDirectory.get(entry.directory) ?? []), entry.id]);
  }
  const internal = store as unknown as { state: ReturnType<PiSessionStore['getState']> };
  internal.state = {
    ...store.getState(),
    connection: 'ready' as const,
    catalog: {
      ...initialCatalog(),
      byId: new Map(records.map((entry) => [entry.id, entry])),
      byDirectory,
      listStatusByDirectory: new Map([...byDirectory.keys()].map((directory) => [directory, 'ready' as const])),
    },
  };
};

type Props = { knownSessionDirectories: Set<string> };

const restoreFns: Array<() => void> = [];
afterEach(() => {
  while (restoreFns.length > 0) restoreFns.pop()!();
});

describe('useSidebarSessions', () => {
  test('keeps a running worktree session through its directory leaving and returning', async () => {
    const store = getPiSessionStore();
    seedCatalog(store, [
      record('orchestrator', PROJECT),
      record('worker', WORKTREE, { parentId: 'orchestrator', lifecycle: 'busy' }),
    ]);

    const dom = installMinimalDom();
    restoreFns.push(dom.restore);
    let visible: Session[] = [];
    const Harness = ({ knownSessionDirectories }: Props) => {
      visible = useSidebarSessions({ enabled: true, knownSessionDirectories, homeDirectory: '/home/user' }).sessions;
      return null;
    };
    const render = (directories: string[]) => act(async () => {
      root.render(React.createElement(Harness, { knownSessionDirectories: new Set(directories) }));
    });
    const visibleIds = () => visible.map((session) => session.id).sort();

    const root: Root = createRoot(dom.container);
    try {
      await render([PROJECT, WORKTREE]);
      expect(visibleIds()).toEqual(['orchestrator', 'worker']);

      // The worktree is removed: discovery drops it from the known set.
      await render([PROJECT]);
      expect(visibleIds()).toEqual(['orchestrator']);
      expect(store.isDeleted('worker')).toBe(false);
      expect(store.getState().catalog.byId.has('worker')).toBe(true);

      // The worktree is recreated at the same path: the session is back.
      await render([PROJECT, WORKTREE]);
      expect(visibleIds()).toEqual(['orchestrator', 'worker']);
      expect(store.isDeleted('worker')).toBe(false);
    } finally {
      await act(async () => root.unmount());
      seedCatalog(store, []);
    }
  });

  test('still cleans up a session the catalog no longer lists', async () => {
    const store = getPiSessionStore();
    seedCatalog(store, [record('kept', PROJECT), record('deleted', PROJECT)]);

    const dom = installMinimalDom();
    restoreFns.push(dom.restore);
    const Harness = () => {
      useSidebarSessions({ enabled: true, knownSessionDirectories: new Set([PROJECT]), homeDirectory: '/home/user' });
      return null;
    };
    const root: Root = createRoot(dom.container);
    try {
      await act(async () => root.render(React.createElement(Harness)));

      // A later authoritative listing of the directory omits the session.
      await act(async () => seedCatalogAndEmit(store, [record('kept', PROJECT)]));
      expect(store.isDeleted('deleted')).toBe(true);
      expect(store.isDeleted('kept')).toBe(false);
    } finally {
      await act(async () => root.unmount());
      seedCatalog(store, []);
    }
  });
});

const seedCatalogAndEmit = (store: PiSessionStore, records: LiveSessionRecord[]) => {
  seedCatalog(store, records);
  (store as unknown as { emit: (topics: string[]) => void }).emit(['catalog']);
};
