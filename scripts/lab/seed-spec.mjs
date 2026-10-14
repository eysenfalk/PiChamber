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
    { project: 'lab-alpha', title: 'Lab: renamed', role: 'fork' },
    // The sidebar tree (issue #95): a fork chain, sessions in worktrees, a chat
    // without a project in the lab home and a session in an unregistered folder.
    { project: 'lab-alpha', title: 'Lab: fork child', role: 'fork-child' },
    { project: 'lab-alpha', worktree: 'sidebar-tree', title: 'Lab: tree row layout', role: 'worktree' },
    { project: 'lab-alpha', worktree: 'quick-find', title: 'Lab: project filter', role: 'worktree' },
    { title: 'Lab: quick chat', role: 'chat' },
    { folder: 'scratch', title: 'Lab: scratch notes', role: 'foreign' },
    // Issue #107: an orchestrator on the scripted faux model (scripts/lab/faux-orchestration.mjs).
    { project: 'lab-alpha', title: 'Lab: orchestrator', role: 'orchestrator' },
    // Issue #147: a session full of Pi custom messages (intercom, subagent notices, an unknown extension).
    { project: 'lab-beta', title: 'Lab: extension messages', role: 'extensions' },
  ],
  // Linked worktrees of a project, checked out next to it as <project>-worktrees/<name>.
  // `git` is the state the git pills show (slice 5 of #95). Every worktree with a state
  // tracks the project's main, which moves on by one commit after they branch off.
  worktrees: [
    // Two uncommitted changes, one commit behind main.
    { project: 'lab-alpha', name: 'sidebar-tree', git: 'dirty' },
    // Two commits ahead of main and one behind, nothing uncommitted.
    { project: 'lab-alpha', name: 'quick-find', git: 'ahead-behind' },
    // A rebase onto main stopped on a conflict.
    { project: 'lab-alpha', name: 'rebase-stop', git: 'rebase' },
    // Tracks a branch on a local bare remote (slice 6 of #95). The remote has one commit
    // the worktree has not fetched, so no `↓` shows until a fetch happens.
    { project: 'lab-alpha', name: 'fetch-me', git: 'remote-ahead' },
  ],
};
