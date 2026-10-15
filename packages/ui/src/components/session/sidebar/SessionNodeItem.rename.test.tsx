import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Issue #143: on the dedicated mobile drawer a session is renamed in a dialog,
// on desktop inline in the row. The real SessionNodeItem and SessionRenameDialog
// are rendered here with a small hook harness (no DOM in this runner, same
// approach as fork-actions.behavior.test.tsx); Dialog, Input and the row's
// menu primitives are stubbed. Base UI routes Escape and an outside tap into
// onOpenChange(false); that routing is not covered here, it was driven in a
// browser (see the pull request).

type Node = { type: unknown; props: Record<string, unknown> };

let slots: unknown[] = [];
let cursor = 0;
let paint: () => void = () => undefined;

const renderElement = (type: unknown, props: Record<string, unknown> | null): unknown => {
  const normalized = props ?? {};
  return typeof type === 'function'
    ? (type as (componentProps: Record<string, unknown>) => unknown)(normalized)
    : { type, props: normalized };
};
const jsxRuntime = {
  Fragment: Symbol('Fragment'),
  jsx: renderElement,
  jsxs: renderElement,
  jsxDEV: renderElement,
};

const React = {
  Fragment: jsxRuntime.Fragment,
  memo: <T,>(component: T) => component,
  useCallback: <T,>(callback: T) => callback,
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
  useMemo: <T,>(factory: () => T) => factory(),
  useRef: <T,>(value: T) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { current: value };
    return slots[index] as { current: T };
  },
  useState: <T,>(initial: T | (() => T)) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    const set = (next: T | ((previous: T) => T)) => {
      const value = typeof next === 'function' ? (next as (previous: T) => T)(slots[index] as T) : next;
      if (Object.is(value, slots[index])) return;
      slots[index] = value;
      paint();
    };
    return [slots[index] as T, set] as const;
  },
};

const host = (type: string) => ({ children, ...props }: Record<string, unknown>) => ({ type, props: { ...props, children } });
const nothing = () => null;

mock.module('react/jsx-runtime', () => jsxRuntime);
mock.module('react/jsx-dev-runtime', () => jsxRuntime);
mock.module('react', () => ({ default: React, ...React }));
mock.module('@base-ui/react/context-menu', () => ({ ContextMenu: { Root: host('menu-root'), Trigger: host('menu-trigger') } }));
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ open, children, ...props }: Record<string, unknown>) => (open ? { type: 'dialog', props: { ...props, children } } : null),
  DialogContent: host('dialog-content'),
  DialogFooter: host('dialog-footer'),
  DialogHeader: host('dialog-header'),
  DialogTitle: host('dialog-title'),
}));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/components/ui/input', () => ({ Input: host('input') }));
mock.module('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));
mock.module('@/stores/utils/streamDebug', () => ({ streamPerfCount: () => undefined }));
mock.module('@/stores/useSessionMultiSelectStore', () => ({ useSessionMultiSelectStore: { getState: () => ({ anchorId: null }) } }));
mock.module('@/components/icon/Icon', () => ({ Icon: nothing }));
mock.module('@/components/chat/AgentThinkingLoader', () => ({ AgentThinkingLoader: nothing }));
mock.module('@/components/session/SessionActivityDuration', () => ({ SessionActivityDuration: nothing }));
mock.module('./QuickSessionAction', () => ({ QuickSessionAction: nothing }));
mock.module('./QuietWorkerMarker', () => ({ QuietWorkerMarker: nothing }));
mock.module('./SessionUnreadDot', () => ({ SessionUnreadDot: nothing }));
mock.module('./SessionNodeExportDialog', () => ({ SessionNodeExportDialog: nothing }));
mock.module('./SessionNodeContextMenu', () => ({ SessionNodeContextMenuContent: nothing, SessionNodeDropdownMenuContent: nothing }));
mock.module('./highlightedText', () => ({ renderHighlightedText: (text: string) => text }));
mock.module('./sessionRowAnchor', () => ({ holdSessionRowPosition: () => undefined }));
mock.module('./useSessionExport', () => ({
  collectNodeDescendantIds: () => [],
  useSessionExport: () => ({
    exportDialogOpen: false,
    setExportDialogOpen: () => undefined,
    exportIncludeSubtasks: false,
    setExportIncludeSubtasks: () => undefined,
    descendantCount: 0,
    handleExportSession: () => undefined,
    doExportSession: () => undefined,
  }),
}));
mock.module('./useSessionNodeItemMetadata', () => ({
  useSessionNodeItemMetadata: ({ node }: { node: { session: { id: string; title: string } } }) => ({
    session: node.session,
    sessionDirectory: '/repo',
    isActive: false,
    tooltipProjectLabel: null,
    tooltipBranchLabel: null,
    isGitRepo: false,
    subtaskCount: 0,
    agentName: null,
    selectionScopeKey: null,
    selectionModeEnabled: false,
    isRowSelected: false,
    toggleRowSelected: () => undefined,
    setRowRange: () => undefined,
    isStreaming: false,
    hasActivityDuration: false,
    sessionTitle: node.session.title,
    hasChildren: false,
    isPinnedSession: false,
    needsAttention: false,
    sessionCompactUpdatedLabel: '1m',
    forkSolid: false,
    rowBackground: null,
  }),
}));

const { SessionNodeItem } = await import('./SessionNodeItem');

const find = (root: unknown, match: (node: Node) => boolean): Node | null => {
  if (Array.isArray(root)) {
    for (const child of root) {
      const found = find(child, match);
      if (found) return found;
    }
    return null;
  }
  if (!root || typeof root !== 'object') return null;
  const node = root as Node;
  if (typeof node.type !== 'string' && typeof node.type !== 'symbol') return null;
  if (match(node)) return node;
  return find(node.props?.children, match);
};
const handler = (node: Node | null, name: string) => {
  const fn = node?.props[name];
  if (typeof fn !== 'function') throw new Error('missing handler ' + name);
  return fn as (...args: unknown[]) => unknown;
};
const submitEvent = () => ({ preventDefault: () => undefined });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const TITLE = 'Old title';
let tree: unknown;
let saved: string[];
let cancels: number;
let saveEdit: (title?: string) => void | Promise<void>;

const mountRow = (mobileVariant: boolean, editTitle = TITLE) => {
  slots = [];
  const props = {
    node: { session: { id: 's1', title: TITLE }, children: [] },
    pinnedSessionIds: new Set<string>(),
    hasSessionSearchQuery: false,
    normalizedSessionSearchQuery: '',
    editingId: 's1',
    setEditingId: () => undefined,
    editTitle,
    setEditTitle: () => undefined,
    handleSaveEdit: (title?: string) => saveEdit(title),
    handleCancelEdit: () => { cancels += 1; },
    handleSessionSelect: () => undefined,
    handleSessionDoubleClick: () => undefined,
    togglePinnedSession: () => undefined,
    handleShareSession: () => undefined,
    copiedSessionId: null,
    handleCopyShareUrl: () => undefined,
    handleCopySessionId: () => undefined,
    handleUnshareSession: () => undefined,
    openSidebarMenuKey: null,
    setOpenSidebarMenuKey: () => undefined,
    renamingFolderId: null,
    getFoldersForScope: () => [],
    getSessionFolderId: () => null,
    removeSessionFromFolder: () => undefined,
    addSessionToFolder: () => undefined,
    createFolderAndStartRename: () => null,
    handleDeleteSession: () => undefined,
    handleRestoreSession: () => undefined,
    mobileVariant,
    alwaysShowActions: false,
    allowQuickArchiveAction: false,
    renderSessionNode: () => null,
    subtreeContainsEditing: new Set<string>(),
    menuOpenSessionId: null,
    nodeStructureKey: 's1',
  };
  const component = SessionNodeItem as unknown as (value: typeof props) => unknown;
  paint = () => {
    cursor = 0;
    tree = component(props);
  };
  paint();
};

const dialog = () => find(tree, (node) => node.type === 'dialog');
const dialogInput = () => find(dialog(), (node) => node.type === 'input');
const dialogForm = () => find(dialog(), (node) => node.type === 'form');
const cancelButton = () => find(dialog(), (node) => node.type === 'button' && node.props.type === 'button');
const alert = () => find(dialog(), (node) => node.props.role === 'alert');
const inlineForm = () => find(tree, (node) => node.type === 'form' && 'data-session-rename-form' in node.props);

beforeEach(() => {
  saved = [];
  cancels = 0;
  saveEdit = (title) => { saved.push(title ?? ''); };
});

describe('renaming a session row on the mobile drawer', () => {
  test('opens a dialog with the current title and no inline field', () => {
    mountRow(true);
    expect(dialog()).not.toBeNull();
    expect(dialogInput()?.props.value).toBe(TITLE);
    expect(inlineForm()).toBeNull();
  });

  test('Enter or Save submits the edited name', () => {
    mountRow(true);
    handler(dialogInput(), 'onChange')({ target: { value: 'New title' } });
    expect(dialogInput()?.props.value).toBe('New title');
    handler(dialogForm(), 'onSubmit')(submitEvent());
    expect(saved).toEqual(['New title']);
    expect(cancels).toBe(0);
  });

  test('Escape, a tap outside and Cancel close without saving', () => {
    mountRow(true);
    handler(dialogInput(), 'onChange')({ target: { value: 'Typed but abandoned' } });
    // Base UI reports Escape and an outside press as onOpenChange(false).
    handler(dialog(), 'onOpenChange')(false);
    handler(cancelButton(), 'onClick')();
    expect(cancels).toBe(2);
    expect(saved).toEqual([]);
  });

  test('a dialog that stays open does not cancel', () => {
    mountRow(true);
    handler(dialog(), 'onOpenChange')(true);
    expect(cancels).toBe(0);
  });

  test('a failed rename keeps the dialog and the draft and says so', async () => {
    saveEdit = async () => { throw new Error('rpc down'); };
    mountRow(true);
    handler(dialogInput(), 'onChange')({ target: { value: 'Draft kept' } });
    handler(dialogForm(), 'onSubmit')(submitEvent());
    await flush();
    expect(dialog()).not.toBeNull();
    expect(dialogInput()?.props.value).toBe('Draft kept');
    expect(JSON.stringify(alert()?.props.children)).toContain('Could not rename the session');
    expect(cancels).toBe(0);
  });

  test('typing again clears the error and a retry that works saves', async () => {
    let fail = true;
    saveEdit = async (title) => {
      if (fail) throw new Error('rpc down');
      saved.push(title ?? '');
    };
    mountRow(true);
    handler(dialogForm(), 'onSubmit')(submitEvent());
    await flush();
    expect(alert()).not.toBeNull();
    fail = false;
    handler(dialogInput(), 'onChange')({ target: { value: 'Second try' } });
    expect(alert()).toBeNull();
    handler(dialogForm(), 'onSubmit')(submitEvent());
    await flush();
    expect(saved).toEqual(['Second try']);
    expect(alert()).toBeNull();
  });
});

describe('renaming a session row on desktop', () => {
  test('stays inline: a form in the row, no dialog', () => {
    mountRow(false);
    expect(dialog()).toBeNull();
    expect(inlineForm()).not.toBeNull();
  });

  test('submitting the inline form saves the typed name', () => {
    mountRow(false);
    const input = find(inlineForm(), (node) => node.type === 'input');
    handler(input, 'onChange')({ target: { value: 'Inline name' } });
    handler(inlineForm(), 'onSubmit')(submitEvent());
    expect(saved).toEqual(['Inline name']);
  });

  test('Escape in the inline field cancels', () => {
    mountRow(false);
    const input = find(inlineForm(), (node) => node.type === 'input');
    handler(input, 'onKeyDown')({ key: 'Escape', stopPropagation: () => undefined });
    expect(cancels).toBe(1);
    expect(saved).toEqual([]);
  });
});
