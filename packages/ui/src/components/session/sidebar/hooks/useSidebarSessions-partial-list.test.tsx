import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/chat/types';

import { getPiSessionStore, type PiSessionStore } from '@/apps/pi-session-store';
import { piClient } from '@/lib/pi/client';
import { initialCatalog, type LiveSessionRecord } from '@/sync/pi-session-catalog';
import { useSidebarSessions } from './useSidebarSessions';

// Issue #126 review: the server skips a session file it cannot read and
// answers with the readable rest, marked `incomplete`. A partial listing is
// not proof that the skipped session was deleted. The sidebar must keep the
// session and must not tombstone it, so it is back once the file is repaired.

const PROJECT = '/repo';

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

const record = (id: string): LiveSessionRecord => ({
  id,
  directory: PROJECT,
  parentId: null,
  title: id,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  lifecycle: 'idle',
  hydrated: false,
});

const listItem = (id: string) => ({
  session: { id, directory: PROJECT, title: id, createdAt: 1, updatedAt: 2, parentId: null, archived: false },
  updatedAt: 2,
});

const seedCatalog = (store: PiSessionStore, records: LiveSessionRecord[]) => {
  const internal = store as unknown as { state: ReturnType<PiSessionStore['getState']> };
  internal.state = {
    ...store.getState(),
    connection: 'ready' as const,
    catalog: {
      ...initialCatalog(),
      byId: new Map(records.map((entry) => [entry.id, entry])),
      byDirectory: records.length > 0 ? new Map([[PROJECT, records.map((entry) => entry.id)]]) : new Map(),
      listStatusByDirectory: records.length > 0 ? new Map([[PROJECT, 'ready' as const]]) : new Map(),
    },
  };
};

type ListResponse = { sessions: ReturnType<typeof listItem>[]; incomplete?: true };

const restoreFns: Array<() => void> = [];
afterEach(() => {
  while (restoreFns.length > 0) restoreFns.pop()!();
});

describe('useSidebarSessions with an incomplete session list', () => {
  test('keeps a session the server skipped and shows it again after the file is repaired', async () => {
    const store = getPiSessionStore();
    seedCatalog(store, [record('healthy'), record('victim')]);

    let response: ListResponse = { sessions: [listItem('healthy'), listItem('victim')] };
    const originalListSessions = piClient.listSessions.bind(piClient);
    piClient.listSessions = (async () => response) as unknown as typeof piClient.listSessions;
    restoreFns.push(() => { piClient.listSessions = originalListSessions; });

    const dom = installMinimalDom();
    restoreFns.push(dom.restore);
    let visible: Session[] = [];
    const Harness = () => {
      visible = useSidebarSessions({ enabled: true, knownSessionDirectories: new Set([PROJECT]), homeDirectory: '/home/user' }).sessions;
      return null;
    };
    const visibleIds = () => visible.map((session) => session.id).sort();
    const refresh = (next: ListResponse) => act(async () => {
      response = next;
      await store.refreshDirectoryCatalog(PROJECT);
    });

    const root: Root = createRoot(dom.container);
    try {
      await act(async () => root.render(React.createElement(Harness)));
      await refresh({ sessions: [listItem('healthy'), listItem('victim')] });
      expect(visibleIds()).toEqual(['healthy', 'victim']);

      // The victim's file is unreadable: the server lists the rest and says so.
      await refresh({ sessions: [listItem('healthy')], incomplete: true });
      expect(store.isDeleted('victim')).toBe(false);
      expect(store.getState().catalog.byId.has('victim')).toBe(true);
      expect(store.getState().catalog.listStatusByDirectory.get(PROJECT)).not.toBe('ready');

      // The file is repaired: the complete list shows the session again.
      await refresh({ sessions: [listItem('healthy'), listItem('victim')] });
      expect(store.isDeleted('victim')).toBe(false);
      expect(visibleIds()).toEqual(['healthy', 'victim']);
      expect(store.getState().catalog.listStatusByDirectory.get(PROJECT)).toBe('ready');
    } finally {
      await act(async () => root.unmount());
      seedCatalog(store, []);
    }
  });

  test('still removes a session a complete list omits', async () => {
    const store = getPiSessionStore();
    seedCatalog(store, [record('kept'), record('deleted')]);

    let response: ListResponse = { sessions: [listItem('kept'), listItem('deleted')] };
    const originalListSessions = piClient.listSessions.bind(piClient);
    piClient.listSessions = (async () => response) as unknown as typeof piClient.listSessions;
    restoreFns.push(() => { piClient.listSessions = originalListSessions; });

    const dom = installMinimalDom();
    restoreFns.push(dom.restore);
    const Harness = () => {
      useSidebarSessions({ enabled: true, knownSessionDirectories: new Set([PROJECT]), homeDirectory: '/home/user' });
      return null;
    };
    const root: Root = createRoot(dom.container);
    try {
      await act(async () => root.render(React.createElement(Harness)));
      await act(async () => {
        response = { sessions: [listItem('kept')] };
        await store.refreshDirectoryCatalog(PROJECT);
      });
      expect(store.isDeleted('deleted')).toBe(true);
      expect(store.isDeleted('kept')).toBe(false);
    } finally {
      await act(async () => root.unmount());
      seedCatalog(store, []);
    }
  });
});
