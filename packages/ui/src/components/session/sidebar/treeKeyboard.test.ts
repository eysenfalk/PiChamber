import { describe, expect, test } from 'bun:test';
import { resolveTreeKey } from './treeKeyboard';
import type { NodeKey, TreeNode, TreeRow } from './workspaceTree';

const rollup = { running: false, waiting: false, unseen: false };

const node = (key: NodeKey, kind: TreeNode['kind'], children: TreeNode[] = [], extra: Partial<TreeNode> = {}): TreeNode => ({
  key,
  kind,
  label: key,
  children,
  sessionCount: 0,
  forkCount: 0,
  lastActivity: 0,
  rollup,
  ...extra,
});

const session = node('s:one', 'session');
const worktree = node('w:/repo', 'worktree', [session], { directory: '/repo' });
const project = node('p:a', 'project', [worktree], { directory: '/repo' });
const chats = node('chats', 'chats', [], { directory: '~' });
const other = node('other', 'other', [], {});

const parents = new Map<NodeKey, NodeKey>([
  ['w:/repo', 'p:a'],
  ['s:one', 'w:/repo'],
]);

const row = (rowNode: TreeNode, depth: number, expanded: boolean): TreeRow => ({
  key: rowNode.key,
  depth,
  node: rowNode,
  expanded,
  guides: [],
  isLast: false,
});

const rows = [row(chats, 0, false), row(project, 0, true), row(worktree, 1, true), row(session, 2, false), row(other, 0, false)];

const press = (focusedKey: NodeKey, key: string, visible = rows) => resolveTreeKey({ rows: visible, parents, focusedKey, key });

describe('resolveTreeKey', () => {
  test('ArrowDown and ArrowUp move between visible rows and stop at the ends', () => {
    expect(press('chats', 'ArrowDown')).toEqual({ type: 'focus', key: 'p:a' });
    expect(press('p:a', 'ArrowUp')).toEqual({ type: 'focus', key: 'chats' });
    expect(press('chats', 'ArrowUp')).toBeNull();
    expect(press('other', 'ArrowDown')).toBeNull();
  });

  test('Home and End jump to the first and last row', () => {
    expect(press('s:one', 'Home')).toEqual({ type: 'focus', key: 'chats' });
    expect(press('s:one', 'End')).toEqual({ type: 'focus', key: 'other' });
  });

  test('ArrowRight expands a closed row, then enters its first child', () => {
    const closed = [row(chats, 0, false), row({ ...project }, 0, false), row(other, 0, false)];
    expect(press('p:a', 'ArrowRight', closed)).toEqual({ type: 'expand', key: 'p:a' });
    expect(press('p:a', 'ArrowRight')).toEqual({ type: 'focus', key: 'w:/repo' });
  });

  test('ArrowRight does nothing on a leaf or on an "N more" row', () => {
    expect(press('s:one', 'ArrowRight')).toBeNull();
    const more = node('more:w:/repo', 'more', [session]);
    expect(press('more:w:/repo', 'ArrowRight', [row(more, 1, false)])).toBeNull();
  });

  test('ArrowLeft collapses an open row, otherwise moves to the parent', () => {
    expect(press('p:a', 'ArrowLeft')).toEqual({ type: 'collapse', key: 'p:a' });
    expect(press('s:one', 'ArrowLeft')).toEqual({ type: 'focus', key: 'w:/repo' });
    expect(press('chats', 'ArrowLeft')).toBeNull();
  });

  test('ArrowLeft skips a revealed "N more" group that has no row', () => {
    const viaMore = new Map<NodeKey, NodeKey>([['s:one', 'more:w:/repo'], ['more:w:/repo', 'w:/repo']]);
    const visible = [row(worktree, 1, true), row(session, 2, false)];
    expect(resolveTreeKey({ rows: visible, parents: viaMore, focusedKey: 's:one', key: 'ArrowLeft' }))
      .toEqual({ type: 'focus', key: 'w:/repo' });
  });

  test('Enter activates any row', () => {
    expect(press('s:one', 'Enter')).toEqual({ type: 'activate', key: 's:one' });
    expect(press('p:a', 'Enter')).toEqual({ type: 'activate', key: 'p:a' });
  });

  test('n starts a session only on Chats, projects and worktrees', () => {
    expect(press('w:/repo', 'n')).toEqual({ type: 'newSession', key: 'w:/repo' });
    expect(press('p:a', 'n')).toEqual({ type: 'newSession', key: 'p:a' });
    expect(press('chats', 'n')).toEqual({ type: 'newSession', key: 'chats' });
    expect(press('s:one', 'n')).toBeNull();
    expect(press('other', 'n')).toBeNull();
  });

  test('ignores other keys and a focused key that is not visible', () => {
    expect(press('chats', 'x')).toBeNull();
    expect(press('s:missing', 'ArrowDown')).toBeNull();
  });
});
