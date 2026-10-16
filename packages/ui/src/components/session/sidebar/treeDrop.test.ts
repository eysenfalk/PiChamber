import { describe, expect, test } from 'bun:test';
import { resolveTreeDrop, type TreeDragData, type TreeDropData } from './treeDrop';
import type { NodeKey } from './workspaceTree';

const SCOPE = '/wt/a';

const parents = new Map<NodeKey, NodeKey>([
  ['f:/wt/a:outer', 'w:/wt/a'],
  ['f:/wt/a:inner', 'f:/wt/a:outer'],
  ['f:/wt/a:sibling', 'w:/wt/a'],
]);

const worktreeTarget = (scopeKey: string | null = SCOPE): TreeDropData => ({ key: `w:${scopeKey}` as NodeKey, scopeKey, folderId: null, projectId: null });
const folderTarget = (folderId: string, scopeKey: string = SCOPE): TreeDropData => ({ key: `f:${scopeKey}:${folderId}` as NodeKey, scopeKey, folderId, projectId: null });
const projectTarget = (projectId: string, scopeKey: string | null = null): TreeDropData => ({ key: `p:${projectId}` as NodeKey, scopeKey, folderId: null, projectId });

const session: TreeDragData = { type: 'session', sessionId: 's1', scopeKey: SCOPE };
const folder = (folderId: string): TreeDragData => ({ type: 'folder', key: `f:${SCOPE}:${folderId}` as NodeKey, folderId, scopeKey: SCOPE });

describe('resolveTreeDrop', () => {
  test('a session dropped on a folder of its scope joins that folder', () => {
    expect(resolveTreeDrop(session, folderTarget('outer'), parents)).toEqual({
      type: 'addSessionToFolder', scopeKey: SCOPE, folderId: 'outer', sessionId: 's1',
    });
  });

  test('a session dropped on the worktree or flat project of its scope leaves its folder', () => {
    expect(resolveTreeDrop(session, worktreeTarget(), parents)).toEqual({
      type: 'removeSessionFromFolder', scopeKey: SCOPE, sessionId: 's1',
    });
  });

  test('a session is refused by another scope, a project with worktrees and Chats', () => {
    expect(resolveTreeDrop(session, worktreeTarget('/wt/b'), parents)).toBeNull();
    expect(resolveTreeDrop(session, folderTarget('outer', '/wt/b'), parents)).toBeNull();
    expect(resolveTreeDrop(session, projectTarget('split'), parents)).toBeNull();
    expect(resolveTreeDrop({ ...session, scopeKey: null }, worktreeTarget(null), parents)).toBeNull();
  });

  test('a folder dropped on another folder of its scope is reparented there', () => {
    expect(resolveTreeDrop(folder('sibling'), folderTarget('outer'), parents)).toEqual({
      type: 'moveFolder', scopeKey: SCOPE, folderId: 'sibling', parentId: 'outer',
    });
  });

  test('a folder dropped on its worktree becomes top level', () => {
    expect(resolveTreeDrop(folder('inner'), worktreeTarget(), parents)).toEqual({
      type: 'moveFolder', scopeKey: SCOPE, folderId: 'inner', parentId: null,
    });
  });

  test('a folder is refused on itself, on its own descendant and in another scope', () => {
    expect(resolveTreeDrop(folder('outer'), folderTarget('outer'), parents)).toBeNull();
    expect(resolveTreeDrop(folder('outer'), folderTarget('inner'), parents)).toBeNull();
    expect(resolveTreeDrop(folder('outer'), worktreeTarget('/wt/b'), parents)).toBeNull();
  });

  test('a project dropped on another project reorders; on itself, a worktree or a folder it does not', () => {
    const drag: TreeDragData = { type: 'project', projectId: 'a' };
    expect(resolveTreeDrop(drag, projectTarget('b', '/src/b'), parents)).toEqual({
      type: 'reorderProject', projectId: 'a', overProjectId: 'b',
    });
    expect(resolveTreeDrop(drag, projectTarget('a'), parents)).toBeNull();
    expect(resolveTreeDrop(drag, worktreeTarget(), parents)).toBeNull();
    expect(resolveTreeDrop(drag, folderTarget('outer'), parents)).toBeNull();
  });
});
