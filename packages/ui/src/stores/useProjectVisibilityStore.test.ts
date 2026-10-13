import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { RuntimeAPIs, SettingsPayload } from '@/lib/api/types';
import type { DesktopSettings } from '@/lib/desktop';
import { invalidateSettingsCache } from '@/lib/persistence';
import { sanitizeWebSettings } from '@/lib/persistence/settingsSanitizers';

// The store registers its settings-synced listener when it loads, so the
// browser globals must exist before the import.
const eventTarget = new EventTarget();
const createdWindow = typeof window === 'undefined';
if (createdWindow) {
  Object.defineProperty(globalThis, 'window', {
    value: {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      setTimeout,
      clearTimeout,
    },
    configurable: true,
    writable: true,
  });
}
const createdLocalStorage = typeof localStorage === 'undefined';
if (createdLocalStorage) {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
      clear: () => values.clear(),
    },
    configurable: true,
    writable: true,
  });
}

const { CHATS_VISIBILITY_ID, sanitizeHiddenProjectIds, useProjectVisibilityStore } = await import('./useProjectVisibilityStore');

const saves: Array<Partial<SettingsPayload>> = [];

const registerSettingsSave = (): void => {
  registerRuntimeAPIs({
    runtime: { platform: 'web', isDesktop: false },
    settings: {
      load: async () => ({ settings: {}, source: 'web' }),
      save: async (changes: Partial<SettingsPayload>) => {
        saves.push(changes);
        return changes;
      },
    },
  } as unknown as RuntimeAPIs);
};

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 350));
const hidden = (): string[] => [...useProjectVisibilityStore.getState().hiddenProjectIds].sort();

describe('useProjectVisibilityStore', () => {
  beforeEach(() => {
    saves.length = 0;
    registerRuntimeAPIs(null);
    invalidateSettingsCache();
    useProjectVisibilityStore.setState({ hiddenProjectIds: new Set() });
    registerSettingsSave();
  });

  afterAll(() => {
    registerRuntimeAPIs(null);
    if (createdWindow) delete (globalThis as { window?: unknown }).window;
    if (createdLocalStorage) delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  test('setHidden adds and removes ids, Chats included, and ignores no-ops', () => {
    const { setHidden } = useProjectVisibilityStore.getState();
    setHidden('p1', true);
    setHidden(CHATS_VISIBILITY_ID, true);
    expect(hidden()).toEqual(['chats', 'p1']);

    const before = useProjectVisibilityStore.getState().hiddenProjectIds;
    setHidden('p1', true);
    expect(useProjectVisibilityStore.getState().hiddenProjectIds).toBe(before);

    setHidden('p1', false);
    expect(hidden()).toEqual(['chats']);
  });

  test('showAll empties the set and hideAll hides exactly the given ids', () => {
    const { setHidden, showAll, hideAll } = useProjectVisibilityStore.getState();
    setHidden('p1', true);
    showAll();
    expect(hidden()).toEqual([]);

    hideAll(['p2', 'p3', 'chats', 'p2']);
    expect(hidden()).toEqual(['chats', 'p2', 'p3']);
    hideAll(['p4']);
    expect(hidden()).toEqual(['p4']);
  });

  test('every change replaces the set instead of mutating it', () => {
    const first = useProjectVisibilityStore.getState().hiddenProjectIds;
    useProjectVisibilityStore.getState().setHidden('p1', true);
    expect(useProjectVisibilityStore.getState().hiddenProjectIds).not.toBe(first);
    expect(first.size).toBe(0);
  });

  test('saves the sorted ids through desktop settings, once for a burst of changes', async () => {
    const { setHidden } = useProjectVisibilityStore.getState();
    setHidden('b', true);
    setHidden('a', true);
    await settled();
    expect(saves).toEqual([{ hiddenProjectIds: ['a', 'b'] }]);
  });

  test('a settings snapshot replaces the set without saving it back', async () => {
    useProjectVisibilityStore.getState().synchronizeFromSettings({ hiddenProjectIds: ['p9', '', 4, 'p9'] } as unknown as DesktopSettings);
    expect(hidden()).toEqual(['p9']);

    // A snapshot without the key is authoritative: nothing is hidden on that runtime.
    useProjectVisibilityStore.getState().synchronizeFromSettings({});
    expect(hidden()).toEqual([]);
    await settled();
    expect(saves).toEqual([]);
  });

  test('follows the settings-synced event', () => {
    window.dispatchEvent(new CustomEvent('pichamber:settings-synced', { detail: { hiddenProjectIds: ['p5'] } }));
    expect(hidden()).toEqual(['p5']);
  });

  test('drops malformed ids and bounds the list', () => {
    expect(sanitizeHiddenProjectIds('nope')).toEqual([]);
    expect(sanitizeHiddenProjectIds([' a ', 'a', '', 1, null])).toEqual(['a']);
    expect(sanitizeHiddenProjectIds(Array.from({ length: 2000 }, (_, index) => `p${index}`))).toHaveLength(1000);
  });

  test('the settings sanitizer lets the key round-trip', () => {
    expect(sanitizeWebSettings({ hiddenProjectIds: ['p1', 'chats'] })?.hiddenProjectIds).toEqual(['p1', 'chats']);
    expect(sanitizeWebSettings({ hiddenProjectIds: 'p1' })?.hiddenProjectIds).toBeUndefined();
  });
});
