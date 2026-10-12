import { describe, expect, test } from 'bun:test';
import type { GitWorktree } from '@/lib/api/types';
import type { Session } from '@/lib/chat/types';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';

import { createSessionOwnershipIndex } from './sessionOwnership';
import {
  buildWorkspaceTree,
  defaultExpanded,
  formatTreeAsText,
  visibleRows,
  type NodeKey,
  type SessionActivity,
  type TreeNode,
  type WorkspaceTree,
  type WorkspaceTreeInput,
} from './workspaceTree';

// Fixture world: invented data, shaped like the owner's machine.
const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

const session = (id: string, directory: string, ageHours: number, extra: Partial<Session> = {}): Session => ({
  id,
  directory,
  title: id,
  time: { created: NOW - ageHours * HOUR, updated: NOW - ageHours * HOUR },
  ...extra,
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
  { id: 'pichamber', label: 'PiChamber', root: '/src/PiChamber' },
  { id: 'notes', label: 'notes', root: '/src/notes' },
];

const worktrees = new Map<string, GitWorktree[]>([
  ['pichamber', [
    worktree('/src/PiChamber', 'main', true),
    worktree('/wt/39-reload-restart', '39-reload-restart'),
    worktree('/wt/45-permissions', '45-permissions'),
  ]],
  ['notes', [worktree('/src/notes', 'main', true)]],
]);

const baseSessions: Session[] = [
  session('chat-a', '~', 1),
  session('chat-b', '~', 30),
  session('main-1', '/src/PiChamber', 2),
  session('main-2', '/src/PiChamber/packages/ui', 5),
  session('reload', '/wt/39-reload-restart', 3),
  session('reload-fork-1', '/wt/39-reload-restart', 4, { parentID: 'reload' }),
  session('reload-fork-2', '/wt/39-reload-restart', 6, { parentID: 'reload' }),
  session('reload-fork-1a', '/wt/39-reload-restart', 7, { parentID: 'reload-fork-1' }),
  session('perm', '/wt/45-permissions', 50),
  session('note', '/src/notes', 12),
  session('scratch', '/tmp/scratch', 8),
  session('old', '/src/PiChamber', 1, { time: { created: NOW - HOUR, updated: NOW - HOUR, archived: NOW } }),
];

type WorldOverrides = Partial<Omit<WorkspaceTreeInput, 'ownership' | 'sessions'>> & { sessions?: Session[] };

const world = (overrides: WorldOverrides = {}): WorkspaceTreeInput => {
  const sessions = overrides.sessions ?? baseSessions;
  const worktreesByProject = overrides.worktreesByProject ?? worktrees;
  const byRoot = new Map<string, GitWorktree[]>();
  for (const project of projects) byRoot.set(project.root, [...(worktreesByProject.get(project.id) ?? [])]);
  const active = sessions.filter((entry) => !entry.time?.archived);
  const ownership = createSessionOwnershipIndex(
    active,
    projects.map((project) => ({ id: project.id, normalizedPath: project.root })),
    byRoot,
  );
  return {
    projects,
    worktreesByProject,
    ownership,
    sessions,
    foldersByScope: {},
    isPinned: () => false,
    activity: new Map(),
    unseen: new Set(),
    discoveryComplete: true,
    ...overrides,
  };
};

const render = (tree: WorkspaceTree, expanded: Iterable<NodeKey>, revealed: Iterable<NodeKey> = []): string =>
  formatTreeAsText(visibleRows(tree, new Set(expanded), new Set(revealed)));

const allKeys = (tree: WorkspaceTree): NodeKey[] => {
  const keys: NodeKey[] = [];
  const walk = (nodes: TreeNode[]) => nodes.forEach((node) => {
    keys.push(node.key);
    walk(node.children);
  });
  walk(tree.roots);
  return keys;
};

const sessionIdsInTree = (tree: WorkspaceTree): string[] => allKeys(tree)
  .filter((key) => key.startsWith('s:'))
  .map((key) => key.slice(2));

describe('buildWorkspaceTree', () => {
  test('renders the fixture world: Chats first, flat single-worktree project, Other folders last', () => {
    const tree = buildWorkspaceTree(world());
    expect(render(tree, ['p:pichamber', 'other'])).toBe([
      '▸ Chats  2',
      '▾ PiChamber  7',
      '  ▸ main  2',
      '  ▸ 39-reload-restart  4',
      '  ▸ 45-permissions  1',
      '▸ notes  1',
      '▾ Other folders  1',
      '  ▸ /tmp/scratch  1',
    ].join('\n'));
  });

  test('nests forks under their parent at any depth and counts direct forks', () => {
    const tree = buildWorkspaceTree(world());
    expect(render(tree, ['p:pichamber', 'w:/wt/39-reload-restart', 's:reload', 's:reload-fork-1'])).toContain([
      '  ▾ 39-reload-restart  4',
      '    ▾ reload  ⑂2',
      '      ▾ reload-fork-1  ⑂1',
      '        reload-fork-1a',
      '      reload-fork-2',
    ].join('\n'));
  });

  test('keeps Chats first even when it is empty, and drops Other folders when nothing is ownerless', () => {
    const sessions = baseSessions.filter((entry) => !entry.directory?.startsWith('~') && entry.id !== 'scratch');
    const tree = buildWorkspaceTree(world({ sessions }));
    expect(render(tree, [])).toBe(['Chats  0', '▸ PiChamber  7', '▸ notes  1'].join('\n'));
  });

  test('orders sessions running, waiting, pinned, then by last activity', () => {
    const sessions = [
      session('fresh', '/src/notes', 1),
      session('pinned', '/src/notes', 9),
      session('waiting', '/src/notes', 20),
      session('running', '/src/notes', 40),
    ];
    const activity = new Map<string, SessionActivity>([['running', 'running'], ['waiting', 'waiting']]);
    const tree = buildWorkspaceTree(world({ sessions, activity, isPinned: (entry) => entry.id === 'pinned' }));
    expect(render(tree, ['p:notes'])).toBe([
      'Chats  0',
      '▸ PiChamber  0',
      '▾ notes  4  [running]',
      '  running  [running]',
      '  waiting  [waiting]',
      '  pinned  [pinned]',
      '  fresh',
    ].join('\n'));
  });

  test('cuts a container after five sessions and reveals the rest only on request', () => {
    const sessions = Array.from({ length: 7 }, (_, index) => session(`n${index + 1}`, '/src/notes', index + 1));
    const tree = buildWorkspaceTree(world({ sessions }));
    expect(render(tree, ['p:notes'])).toBe([
      'Chats  0',
      '▸ PiChamber  0',
      '▾ notes  7',
      '  n1', '  n2', '  n3', '  n4', '  n5',
      '  … 2 more',
    ].join('\n'));
    expect(render(tree, ['p:notes'], ['more:p:notes'])).toContain(['  n5', '  n6', '  n7'].join('\n'));
  });

  test('adds a folder level only where the worktree has session folders', () => {
    const folder = (id: string, name: string, sessionIds: string[], createdAt: number, parentId?: string): SessionFolder =>
      ({ id, name, sessionIds, createdAt, parentId });
    const tree = buildWorkspaceTree(world({
      foldersByScope: {
        '/wt/39-reload-restart': [
          folder('review', 'Review', ['reload'], 1),
          folder('deep', 'Deep', [], 2, 'review'),
        ],
      },
    }));
    const text = render(tree, ['p:pichamber', 'w:/src/PiChamber', 'w:/wt/39-reload-restart', 'f:/wt/39-reload-restart:review']);
    expect(text).toContain(['  ▾ main  2', '    main-1', '    main-2'].join('\n'));
    expect(text).toContain([
      '  ▾ 39-reload-restart  4',
      '    ▾ Review  4',
      '      ▸ reload  ⑂2',
      '      Deep  0',
    ].join('\n'));
  });

  test('groups merged worktrees under one row per project', () => {
    const tree = buildWorkspaceTree(world({ mergedWorktrees: new Set(['/wt/45-permissions']) }));
    expect(render(tree, ['p:pichamber'])).toContain([
      '  ▸ main  2',
      '  ▸ 39-reload-restart  4',
      '  ▸ 1 merged',
    ].join('\n'));
  });

  test('rolls running and unseen state up to collapsed ancestors', () => {
    const tree = buildWorkspaceTree(world({
      activity: new Map([['reload-fork-1a', 'running']]),
      unseen: new Set(['perm']),
    }));
    expect(render(tree, [])).toContain('▸ PiChamber  7  [running, unseen]');
  });

  test('keeps ownerless sessions in their last place while worktree discovery is incomplete', () => {
    const before = buildWorkspaceTree(world());
    expect(before.placement.get('perm')).toBe('w:/wt/45-permissions');
    // The 45 worktree is not discovered yet: the ownership index cannot place `perm`.
    const partial = new Map(worktrees);
    partial.set('pichamber', partial.get('pichamber')!.filter((entry) => entry.path !== '/wt/45-permissions'));
    const loading = buildWorkspaceTree(world({
      worktreesByProject: partial,
      discoveryComplete: false,
      previous: before,
    }));
    expect(loading.placement.get('perm')).toBe('w:/wt/45-permissions');
    expect(render(loading, [])).not.toContain('perm');
    expect(render(loading, ['other'])).toBe(render(before, ['other']));

    const settled = buildWorkspaceTree(world({ worktreesByProject: partial, previous: before }));
    expect(render(settled, ['other'])).toContain('  ▸ /wt/45-permissions  1');
  });

  test('leaves archived sessions out', () => {
    expect(sessionIdsInTree(buildWorkspaceTree(world()))).not.toContain('old');
  });

  test('places every active session exactly once (conservation)', () => {
    const shapes: WorldOverrides[] = [
      {},
      { mergedWorktrees: new Set(['/wt/39-reload-restart']) },
      { worktreesByProject: new Map(), discoveryComplete: false },
      {
        sessions: [
          ...baseSessions,
          // A parent cycle and a self parent must not hide sessions.
          session('cycle-a', '/src/notes', 3, { parentID: 'cycle-b' }),
          session('cycle-b', '/src/notes', 4, { parentID: 'cycle-a' }),
          session('self', '/src/notes', 5, { parentID: 'self' }),
          // A fork whose parent lives in another worktree stays in its own.
          session('cross', '/wt/45-permissions', 2, { parentID: 'main-1' }),
          ...Array.from({ length: 9 }, (_, index) => session(`bulk${index}`, '/wt/45-permissions', 60 + index)),
        ],
        foldersByScope: {
          '/wt/45-permissions': [
            { id: 'a', name: 'A', sessionIds: ['bulk1', 'bulk2', 'missing'], createdAt: 1, parentId: 'b' },
            { id: 'b', name: 'B', sessionIds: ['bulk1'], createdAt: 2, parentId: 'a' },
          ],
        },
      },
    ];
    for (const shape of shapes) {
      const input = world(shape);
      const tree = buildWorkspaceTree(input);
      const expected = input.sessions.filter((entry) => !entry.time?.archived).map((entry) => entry.id).sort();
      expect(sessionIdsInTree(tree).sort()).toEqual(expected);
      expect(tree.sessionCount).toBe(expected.length);
      expect(new Set(allKeys(tree)).size).toBe(allKeys(tree).length);
    }
  });
});

describe('defaultExpanded', () => {
  test('opens the project and worktree of the active session and nothing else', () => {
    const tree = buildWorkspaceTree(world());
    expect([...defaultExpanded(tree, 'reload-fork-1')]).toEqual(['s:reload', 'w:/wt/39-reload-restart', 'p:pichamber']);
    expect(render(tree, defaultExpanded(tree, 'note'))).toContain('▾ notes  1\n  note');
    expect(defaultExpanded(tree, null).size).toBe(0);
  });
});
