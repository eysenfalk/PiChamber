import { describe, expect, test } from 'bun:test';
import type { GitWorktree } from '@/lib/api/types';
import type { Session } from '@/lib/chat/types';

import { canQuickCreate, canShowQuickCreateButton, createSessionInWorkspace, type CreateSessionInWorkspaceDeps } from './quickCreate';
import { createSessionOwnershipIndex } from './sessionOwnership';
import { buildWorkspaceTree, type TreeNode, type WorkspaceTreeInput } from './workspaceTree';

const NOW = 1_800_000_000_000;

const session = (id: string, directory: string, ageHours: number): Session => ({
  id,
  directory,
  title: id,
  time: { created: NOW - ageHours * 3_600_000, updated: NOW - ageHours * 3_600_000 },
});

const worktree = (path: string, branch: string, isPrimary = false): GitWorktree => ({
  head: 'abc1234',
  name: path.slice(path.lastIndexOf('/') + 1),
  branch,
  path,
  isPrimary,
  detached: false,
  locked: false,
  prunable: false,
});

const projects = [
  { id: 'multi', label: 'Multi', root: '/src/multi' },
  { id: 'flat', label: 'Flat', root: '/src/flat' },
];

const sessions: Session[] = [
  session('chat', '~', 1),
  session('main-1', '/src/multi', 2),
  session('feature-1', '/wt/feature', 3),
  session('merged-1', '/wt/done', 4),
  session('flat-1', '/src/flat', 5),
  session('flat-2', '/src/flat', 6),
  session('flat-3', '/src/flat', 7),
  session('flat-4', '/src/flat', 8),
  session('flat-5', '/src/flat', 9),
  session('flat-6', '/src/flat', 10),
  session('flat-7', '/src/flat', 11),
  session('stray', '/tmp/stray', 12),
];

const worktreesByProject = new Map<string, GitWorktree[]>([
  ['multi', [worktree('/src/multi', 'main', true), worktree('/wt/feature', 'feature'), worktree('/wt/done', 'done')]],
  ['flat', [worktree('/src/flat', 'main', true)]],
]);

const input = (overrides: Partial<WorkspaceTreeInput> = {}): WorkspaceTreeInput => ({
  projects,
  worktreesByProject,
  ownership: createSessionOwnershipIndex(
    sessions,
    projects.map((project) => ({ id: project.id, normalizedPath: project.root })),
    new Map(projects.map((project) => [project.root, [...(worktreesByProject.get(project.id) ?? [])]])),
  ),
  sessions,
  foldersByScope: { '/src/flat': [{ id: 'f1', name: 'Folder', sessionIds: ['flat-1'], createdAt: NOW, parentId: null }] },
  isPinned: () => false,
  activity: new Map(),
  unseen: new Set(),
  discoveryComplete: true,
  mergedWorktrees: new Set(['/wt/done']),
  ...overrides,
});

const flatten = (nodes: readonly TreeNode[]): TreeNode[] => nodes.flatMap((node) => [node, ...flatten(node.children)]);

const kindsWithButton = (nodes: readonly TreeNode[]): string[] => (
  flatten(nodes).filter(canQuickCreate).map((node) => `${node.kind}:${node.key}`).sort()
);

describe('quick create visibility', () => {
  test('only Chats, worktrees and flat projects get the + button', () => {
    const tree = buildWorkspaceTree(input());
    const kinds = new Set(flatten(tree.roots).map((node) => node.kind));
    // The fixture covers every kind the rule must reject.
    for (const kind of ['session', 'folder', 'more', 'merged', 'other', 'otherFolder', 'project'] as const) {
      expect(kinds.has(kind)).toBe(true);
    }
    expect(kindsWithButton(tree.roots)).toEqual([
      'chats:chats',
      'project:p:flat',
      'worktree:w:/src/multi',
      'worktree:w:/wt/done',
      'worktree:w:/wt/feature',
    ]);
  });

  test('a project with worktrees keeps its row free of the button', () => {
    const tree = buildWorkspaceTree(input());
    const multi = tree.roots.find((node) => node.key === 'p:multi');
    expect(multi && canQuickCreate(multi)).toBe(false);
  });

  test('the rule survives a search that narrows the tree to the project row', () => {
    const tree = buildWorkspaceTree(input({ query: 'multi' }));
    const multi = tree.roots.find((node) => node.key === 'p:multi');
    expect(multi && canQuickCreate(multi)).toBe(false);
    const flat = buildWorkspaceTree(input({ query: 'flat' })).roots.find((node) => node.key === 'p:flat');
    expect(flat && canQuickCreate(flat)).toBe(true);
  });

  test('rows without a directory never qualify', () => {
    expect(canQuickCreate({ kind: 'worktree', projectId: 'a', directory: undefined, folderScopeKey: undefined })).toBe(false);
    expect(canQuickCreate({ kind: 'project', projectId: 'a', directory: '/a', folderScopeKey: undefined })).toBe(false);
    expect(canQuickCreate({ kind: 'project', projectId: undefined, directory: '/a', folderScopeKey: '/a' })).toBe(false);
  });

  test('the hover button is withheld on dedicated mobile and touch-only pointers', () => {
    const chats = { kind: 'chats', projectId: undefined, directory: '~', folderScopeKey: undefined } as const;
    expect(canShowQuickCreateButton(chats, { mobileVariant: false, hasTouchOnlyPointer: false })).toBe(true);
    expect(canShowQuickCreateButton(chats, { mobileVariant: true, hasTouchOnlyPointer: false })).toBe(false);
    expect(canShowQuickCreateButton(chats, { mobileVariant: false, hasTouchOnlyPointer: true })).toBe(false);
  });
});

describe('createSessionInWorkspace', () => {
  const run = (target: Parameters<typeof createSessionInWorkspace>[0], overrides: Partial<CreateSessionInWorkspaceDeps> = {}) => {
    const calls: string[] = [];
    createSessionInWorkspace(target, {
      closeMainSurfaces: () => calls.push('closeMainSurfaces'),
      showChat: () => calls.push('showChat'),
      openNewSessionDraft: (options) => calls.push(`draft:${JSON.stringify(options ?? null)}`),
      onNavigateAway: () => calls.push('navigateAway'),
      focusComposer: () => calls.push('focusComposer'),
      ...overrides,
    });
    return calls;
  };

  test('a worktree opens a draft in its own directory, then focuses the composer', () => {
    expect(run({ kind: 'worktree', projectId: 'multi', directory: '/wt/feature' })).toEqual([
      'closeMainSurfaces',
      'showChat',
      'draft:{"selectedProjectId":"multi","directoryOverride":"/wt/feature"}',
      'navigateAway',
      'focusComposer',
    ]);
  });

  test('a flat project opens a draft in its root', () => {
    expect(run({ kind: 'project', projectId: 'flat', directory: '/src/flat' })).toContain(
      'draft:{"selectedProjectId":"flat","directoryOverride":"/src/flat"}',
    );
  });

  test('Chats starts a draft without a folder', () => {
    const calls = run({ kind: 'chats', projectId: undefined, directory: '~' });
    expect(calls).toContain('draft:{"selectedProjectId":"__home__"}');
    expect(calls.some((call) => call.includes('directoryOverride'))).toBe(false);
  });

  test('no target starts a plain draft', () => {
    expect(run(undefined)).toContain('draft:null');
  });

  test('the composer is left alone where the caller withholds focus', () => {
    expect(run({ kind: 'chats', projectId: undefined, directory: '~' }, { focusComposer: undefined })).not.toContain('focusComposer');
  });
});
