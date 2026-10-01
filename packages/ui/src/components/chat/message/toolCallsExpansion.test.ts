import { beforeEach, describe, expect, test } from 'bun:test';

import { useUIStore } from '@/stores/useUIStore';
import {
  expandedToolsStateCache,
  readExpandedToolsCache,
  writeExpandedToolsCache,
} from './chatToolExpansion';
import { resolveOpenToolIds, toggleToolCallsExpanded } from './toolCallsExpansion';

beforeEach(() => {
  expandedToolsStateCache.clear();
  useUIStore.setState({ expandToolCallsByDefault: false, toolCallsExpandedOverride: null });
});

describe('resolveOpenToolIds', () => {
  test('with expand-all off, only the flipped tools are open', () => {
    expect([...resolveOpenToolIds(['a', 'b', 'c'], new Set(['b']), false)]).toEqual(['b']);
  });

  test('with expand-all on, every tool is open except the flipped ones', () => {
    expect([...resolveOpenToolIds(['a', 'b', 'c'], new Set(['b']), true)]).toEqual(['a', 'c']);
  });

  test('a flipped id that is not in the list does not open anything', () => {
    expect([...resolveOpenToolIds(['a'], new Set(['gone']), false)]).toEqual(['gone']);
    expect([...resolveOpenToolIds(['a'], new Set(['gone']), true)]).toEqual(['a']);
  });
});

describe('expanded tools cache', () => {
  test('a record written under one default is not read under the other', () => {
    writeExpandedToolsCache('msg', new Set(['t1']), false);
    expect(readExpandedToolsCache('msg', false).has('t1')).toBe(true);
    expect(readExpandedToolsCache('msg', true).size).toBe(0);
  });

  test('defaults to the closed-by-default mode', () => {
    writeExpandedToolsCache('msg', new Set(['t1']));
    expect(readExpandedToolsCache('msg').has('t1')).toBe(true);
  });
});

describe('toggleToolCallsExpanded', () => {
  test('flips from the saved preference and keeps flipping', () => {
    toggleToolCallsExpanded();
    expect(useUIStore.getState().toolCallsExpandedOverride).toBe(true);
    toggleToolCallsExpanded();
    expect(useUIStore.getState().toolCallsExpandedOverride).toBe(false);
  });

  test('starts from an enabled preference when no override is set', () => {
    useUIStore.setState({ expandToolCallsByDefault: true });
    toggleToolCallsExpanded();
    expect(useUIStore.getState().toolCallsExpandedOverride).toBe(false);
  });

  test('changing the saved preference clears the override', () => {
    toggleToolCallsExpanded();
    useUIStore.getState().setExpandToolCallsByDefault(true);
    expect(useUIStore.getState().toolCallsExpandedOverride).toBe(null);
    expect(useUIStore.getState().expandToolCallsByDefault).toBe(true);
  });

  test('the override is not persisted', () => {
    useUIStore.setState({ expandToolCallsByDefault: true, toolCallsExpandedOverride: false });
    const options = (
      useUIStore as unknown as {
        persist: { getOptions: () => { partialize: (s: Record<string, unknown>) => Record<string, unknown> } };
      }
    ).persist.getOptions();
    const persisted = options.partialize(useUIStore.getState() as unknown as Record<string, unknown>);
    expect(persisted['expandToolCallsByDefault']).toBe(true);
    expect('toolCallsExpandedOverride' in persisted).toBe(false);
  });
});
