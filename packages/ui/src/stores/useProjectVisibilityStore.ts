import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { DesktopSettings } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getDeferredSafeStorage } from './utils/safeStorage';

/** Visibility key of the Chats root; every other key is a registered project id. */
export const CHATS_VISIBILITY_ID = 'chats';

const STORAGE_KEY_PREFIX = 'pichamber.projectVisibility.v1:';
const MAX_HIDDEN_IDS = 1000;

interface ProjectVisibilityStore {
  /**
   * Projects (by id) and Chats (`CHATS_VISIBILITY_ID`) the owner hid from the
   * sidebar tree. Hidden projects stay registered and keep loading their
   * sessions; only the tree omits them, and the quick search still finds them.
   * Always replaced, never mutated, so selectors can compare by reference.
   */
  hiddenProjectIds: ReadonlySet<string>;
  setHidden: (id: string, hidden: boolean) => void;
  showAll: () => void;
  /** Hides exactly these ids (the checklist's None, with every project and Chats). */
  hideAll: (ids: Iterable<string>) => void;
  synchronizeFromSettings: (settings: DesktopSettings) => void;
  resetForRuntimeSwitch: () => void;
}

const storage = getDeferredSafeStorage();

const getStorageKey = (): string => `${STORAGE_KEY_PREFIX}${encodeURIComponent(getRuntimeKey())}`;

/** Non-empty unique string ids, bounded; anything else is dropped. */
export const sanitizeHiddenProjectIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim();
    if (id.length === 0) continue;
    ids.add(id);
    if (ids.size >= MAX_HIDDEN_IDS) break;
  }
  return [...ids];
};

const toSortedArray = (ids: ReadonlySet<string>): string[] => [...ids].sort();

const readCachedHiddenIds = (): ReadonlySet<string> => {
  try {
    const raw = storage.getItem(getStorageKey());
    return raw ? new Set(sanitizeHiddenProjectIds(JSON.parse(raw))) : new Set();
  } catch {
    return new Set();
  }
};

const areSetsEqual = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => {
  if (left.size !== right.size) return false;
  for (const id of left) {
    if (!right.has(id)) return false;
  }
  return true;
};

/** The browser copy only avoids a flash of hidden projects before the settings snapshot arrives. */
const cacheHiddenIds = (ids: ReadonlySet<string>): void => {
  try {
    storage.setItem(getStorageKey(), JSON.stringify(toSortedArray(ids)));
  } catch {
    // ignored: the server settings stay authoritative
  }
};

const persistHiddenIds = (ids: ReadonlySet<string>): void => {
  cacheHiddenIds(ids);
  void updateDesktopSettings({ hiddenProjectIds: toSortedArray(ids) });
};

export const useProjectVisibilityStore = create<ProjectVisibilityStore>()(
  devtools((set, get) => {
    const commit = (next: ReadonlySet<string>): void => {
      if (areSetsEqual(get().hiddenProjectIds, next)) return;
      set({ hiddenProjectIds: next });
      persistHiddenIds(next);
    };

    return {
      hiddenProjectIds: readCachedHiddenIds(),

      setHidden: (id, hidden) => {
        const normalized = id.trim();
        if (!normalized) return;
        const current = get().hiddenProjectIds;
        if (current.has(normalized) === hidden) return;
        const next = new Set(current);
        if (hidden) next.add(normalized);
        else next.delete(normalized);
        commit(next);
      },

      showAll: () => {
        commit(new Set());
      },

      hideAll: (ids) => {
        commit(new Set(sanitizeHiddenProjectIds([...ids])));
      },

      synchronizeFromSettings: (settings) => {
        // A settings snapshot is authoritative: a document without the key
        // means nothing is hidden on this runtime. Never written back.
        const incoming = new Set(sanitizeHiddenProjectIds(settings.hiddenProjectIds));
        if (areSetsEqual(get().hiddenProjectIds, incoming)) return;
        set({ hiddenProjectIds: incoming });
        cacheHiddenIds(incoming);
      },

      resetForRuntimeSwitch: () => {
        // Project ids belong to one runtime. Start from the new runtime's own
        // browser copy until its settings snapshot arrives.
        set({ hiddenProjectIds: readCachedHiddenIds() });
      },
    };
  }, { name: 'project-visibility-store' }),
);

if (typeof window !== 'undefined') {
  window.addEventListener('pichamber:settings-synced', (event: Event) => {
    const detail = (event as CustomEvent<DesktopSettings>).detail;
    if (detail && typeof detail === 'object') {
      useProjectVisibilityStore.getState().synchronizeFromSettings(detail);
    }
  });
}
