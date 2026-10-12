export const SEED_MANIFEST = {
  projects: [
    { name: 'lab-alpha', path: '/lab/projects/lab-alpha' },
    { name: 'lab-beta', path: '/lab/projects/lab-beta' },
    { name: 'lab-gamma', path: '/lab/projects/lab-gamma' },
  ],
  sessions: [
    { project: 'lab-alpha', title: 'Lab: tools session', role: 'long' },
    { project: 'lab-beta', title: 'Lab: short session', role: 'short' },
    { project: 'lab-gamma', title: 'Lab: release notes', role: 'short' },
    // A fork of the long session, renamed and then worked on until the rename
    // lies far before the end of a large file (issue #51).
    { project: 'lab-alpha', title: 'Lab: renamed fork', role: 'fork' },
    // The sidebar tree (issue #95): a fork chain, sessions in worktrees, a chat
    // without a project in the lab home and a session in an unregistered folder.
    { project: 'lab-alpha', title: 'Lab: fork child', role: 'fork-child' },
    { project: 'lab-alpha', worktree: 'sidebar-tree', title: 'Lab: tree row layout', role: 'worktree' },
    { project: 'lab-alpha', worktree: 'search-filter', title: 'Lab: project filter', role: 'worktree' },
    { title: 'Lab: quick chat', role: 'chat' },
    { folder: 'scratch', title: 'Lab: scratch notes', role: 'foreign' },
  ],
  // Linked worktrees of a project, checked out next to it as <project>-worktrees/<name>.
  worktrees: [
    { project: 'lab-alpha', name: 'sidebar-tree' },
    { project: 'lab-alpha', name: 'search-filter' },
  ],
};
