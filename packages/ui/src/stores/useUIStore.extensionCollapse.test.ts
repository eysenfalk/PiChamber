import { beforeEach, describe, expect, test } from 'bun:test';

import { useUIStore } from './useUIStore';

beforeEach(() => {
  useUIStore.setState({ extensionWidgetsCollapsed: false, extensionStatusCollapsed: false });
});

describe('useUIStore extension surface collapse', () => {
  test('both surfaces default to expanded', () => {
    const state = useUIStore.getState();
    expect(state.extensionWidgetsCollapsed).toBe(false);
    expect(state.extensionStatusCollapsed).toBe(false);
  });

  test('each setter changes only its own surface', () => {
    useUIStore.getState().setExtensionWidgetsCollapsed(true);
    expect(useUIStore.getState().extensionWidgetsCollapsed).toBe(true);
    expect(useUIStore.getState().extensionStatusCollapsed).toBe(false);

    useUIStore.getState().setExtensionStatusCollapsed(true);
    useUIStore.getState().setExtensionWidgetsCollapsed(false);
    expect(useUIStore.getState().extensionWidgetsCollapsed).toBe(false);
    expect(useUIStore.getState().extensionStatusCollapsed).toBe(true);
  });

  test('both fields are part of the persisted slice', () => {
    useUIStore.setState({ extensionWidgetsCollapsed: true, extensionStatusCollapsed: true });
    const persisted = useUIStore.persist.getOptions().partialize?.(useUIStore.getState()) as Record<string, unknown>;
    expect(persisted.extensionWidgetsCollapsed).toBe(true);
    expect(persisted.extensionStatusCollapsed).toBe(true);

    useUIStore.setState({ extensionWidgetsCollapsed: false, extensionStatusCollapsed: false });
    const defaults = useUIStore.persist.getOptions().partialize?.(useUIStore.getState()) as Record<string, unknown>;
    expect(defaults.extensionWidgetsCollapsed).toBe(false);
    expect(defaults.extensionStatusCollapsed).toBe(false);
  });
});
