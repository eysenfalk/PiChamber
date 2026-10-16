import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// ---------------------------------------------------------------------------
// The web and desktop app (`App.tsx`) mounts `SyncAppEffects`, and with it the
// bootstrap bridge, inside the real `PiSessionProvider`, which focuses the
// active project. Pi session store, provider, bridge and project store stay
// real here; the directory, session UI and config stores and unrelated hooks
// are stubbed. Per-file isolation (`bun test --isolate`) keeps the mocks local.
// ---------------------------------------------------------------------------

type Listener = () => void;

const createMutableStore = <T extends object>(initial: T) => {
  let state = initial;
  const listeners = new Set<Listener>();
  const subscribe = (listener: Listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const getState = () => state;
  const setState = (patch: Partial<T>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const useStore = <S,>(selector: (value: T) => S): S => React.useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
  return Object.assign(useStore, { getState, setState, subscribe, reset: (value: T) => { state = value; } });
};

const initialDirectoryState = () => ({
  currentDirectory: '/b',
  setDirectory: (directory: string) => directoryStore.setState({ currentDirectory: directory }),
});
const directoryStore = createMutableStore(initialDirectoryState());

const initialSessionUI = () => ({
  currentSessionId: null as string | null,
  currentSessionDirectory: null as string | null,
  newSessionDraft: null as { open: boolean } | null,
});
const sessionUIStore = createMutableStore(initialSessionUI());

const configSnapshot = {
  initializeApp: async () => undefined,
  isInitialized: true,
  isConnected: true,
  providers: [{}],
  loadProviders: async () => undefined,
  activateDirectory: async () => undefined,
};

mock.module('@/hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: () => undefined }));
mock.module('@/hooks/usePwaManifestSync', () => ({ usePwaManifestSync: () => undefined }));
mock.module('@/hooks/useQueuedMessageAutoSend', () => ({ useQueuedMessageAutoSend: () => undefined }));
mock.module('@/hooks/useSessionAutoCleanup', () => ({ useSessionAutoCleanup: () => undefined }));
mock.module('@/hooks/useWindowControlsOverlayLayout', () => ({ useWindowControlsOverlayLayout: () => undefined }));
mock.module('@/hooks/useDesktopMenuActions', () => ({ useDesktopMenuActions: () => undefined }));
mock.module('@/sync/pi-session-catalog-feeder', () => ({ PiSessionCatalogFeeder: () => null }));
mock.module('@/sync/worktree-discovery', () => ({ WorktreeDiscovery: () => null }));
mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: sessionUIStore }));
mock.module('@/stores/useDirectoryStore', () => ({ useDirectoryStore: directoryStore }));
mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: Object.assign((selector: (s: typeof configSnapshot) => unknown) => selector(configSnapshot), {
    getState: () => configSnapshot,
  }),
}));
mock.module('@/lib/persistence', () => ({ syncDesktopSettings: () => Promise.resolve(), updateDesktopSettings: () => Promise.resolve() }));
mock.module('@/sync/last-session-cache', () => ({
  readLastActiveSession: () => null,
  clearLastActiveSession: () => undefined,
  persistLastActiveSession: () => undefined,
}));
mock.module('@/lib/runtime-switch', () => ({
  getActiveRelayTunnel: () => null,
  getRuntimeApiBaseUrl: () => 'http://localhost',
  getRuntimeKey: () => 'web-runtime',
  getRuntimeEndpointGeneration: () => 0,
  initializeRuntimeEndpoint: () => undefined,
  switchRuntimeEndpoint: () => undefined,
  subscribeRuntimeEndpointChanged: () => () => undefined,
  subscribeRuntimeEndpointWillChange: () => () => undefined,
}));
mock.module('@/apps/mobileNativeChrome', () => ({
  isCapacitorMobileApp: () => false,
  useNativeMobileChrome: () => undefined,
  useNativeMobileLifecycle: () => undefined,
  useNativeAndroidBackButton: () => undefined,
}));

const { SyncAppEffects } = await import('./AppEffects');
const { PiSessionProvider } = await import('@/sync/pi-session-context');
const { getPiSessionStore } = await import('@/apps/pi-session-store');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { piClient } = await import('@/lib/pi/client');

const originals = {
  selectProject: piClient.selectProject.bind(piClient),
  listSessions: piClient.listSessions.bind(piClient),
  getSession: piClient.getSession.bind(piClient),
};

const installPiStubs = () => {
  piClient.selectProject = (async (directory: string) => ({ directory })) as unknown as typeof piClient.selectProject;
  piClient.listSessions = (async () => ({ sessions: [] })) as unknown as typeof piClient.listSessions;
  piClient.getSession = (async (id: string) => ({
    session: { id, directory: '/b' },
    lastSequence: 0,
    messages: [],
  })) as unknown as typeof piClient.getSession;
};

/** Attach the singleton store as a connected cluster focused on `directory`. */
const attachStoreAt = (directory: string) => {
  const store = getPiSessionStore();
  const internal = store as unknown as { stream: unknown; state: ReturnType<typeof store.getState> };
  internal.stream = { dispose: () => undefined };
  internal.state = { ...store.getState(), directory, connection: 'ready', selectedSessionId: null };
  return store;
};

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
  setGlobal('location', { search: '', pathname: '/', hash: '', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost', href: 'http://localhost/' });
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

const roots: Root[] = [];
const restores: Array<() => void> = [];

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

/** Mount the bridge the way `App.tsx` does: inside the real provider. */
const mountWebApp = async () => {
  const dom = installMinimalDom();
  restores.push(dom.restore);
  const root = createRoot(dom.container);
  roots.push(root);
  await act(async () => {
    root.render(
      <PiSessionProvider>
        <SyncAppEffects embeddedBackgroundWorkEnabled={false} />
      </PiSessionProvider>,
    );
  });
  await flush();
};

const setupProjects = () => {
  useProjectsStore.setState({
    projects: [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }] as never,
    activeProjectId: 'b',
  });
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  restores.splice(0).forEach((restore) => restore());
  piClient.selectProject = originals.selectProject;
  piClient.listSessions = originals.listSessions;
  piClient.getSession = originals.getSession;
  getPiSessionStore().dispose();
  directoryStore.reset(initialDirectoryState());
  sessionUIStore.reset(initialSessionUI());
  useProjectsStore.setState({ projects: [], activeProjectId: null });
});

describe('web/desktop bridge inside PiSessionProvider (App.tsx)', () => {
  test('a project switch after a Pi focus change in the same commit moves project, folder and focus', async () => {
    installPiStubs();
    setupProjects();
    const store = attachStoreAt('/b');
    await mountWebApp();

    await act(async () => {
      void store.focusProject('/x', null);
      useProjectsStore.getState().setActiveProject('a');
    });
    await flush();

    expect(useProjectsStore.getState().activeProjectId).toBe('a');
    expect(directoryStore.getState().currentDirectory).toBe('/a');
    expect(store.getState().directory).toBe('/a');
  });

  test('control: a Pi focus change and a later project switch in separate commits', async () => {
    installPiStubs();
    setupProjects();
    const store = attachStoreAt('/b');
    await mountWebApp();

    await act(async () => {
      void store.focusProject('/x', null);
    });
    await flush();
    // The bridge mirrors a focus change into the directory store.
    expect(directoryStore.getState().currentDirectory).toBe('/x');

    await act(async () => {
      useProjectsStore.getState().setActiveProject('a');
    });
    await flush();
    expect(useProjectsStore.getState().activeProjectId).toBe('a');
    expect(directoryStore.getState().currentDirectory).toBe('/a');
    expect(store.getState().directory).toBe('/a');
  });

  // On web and desktop no user action calls `focusProject` directly; folder
  // choices go through the project and directory stores. A programmatic
  // focus right after a project switch therefore yields to the project the
  // provider focuses, but project, folder and focus must still agree.
  test('a programmatic Pi focus right after a project switch does not split project and folder', async () => {
    installPiStubs();
    setupProjects();
    const store = attachStoreAt('/b');
    await mountWebApp();

    await act(async () => {
      useProjectsStore.getState().setActiveProject('a');
      void store.focusProject('/x', null);
    });
    await flush();

    expect(useProjectsStore.getState().activeProjectId).toBe('a');
    expect(directoryStore.getState().currentDirectory).toBe('/a');
    expect(store.getState().directory).toBe('/a');
  });
});
