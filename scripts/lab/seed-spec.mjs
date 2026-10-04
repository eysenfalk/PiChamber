export const SEED_MANIFEST = {
  projects: [
    { name: 'lab-alpha', path: '/lab/projects/lab-alpha' },
    { name: 'lab-beta', path: '/lab/projects/lab-beta' },
    { name: 'lab-gamma', path: '/lab/projects/lab-gamma' },
  ],
  sessions: [
    { project: 'lab-alpha', title: 'Lab: long session with tools', role: 'long' },
    { project: 'lab-beta', title: 'Lab: short session', role: 'short' },
    { project: 'lab-gamma', title: 'Lab: release notes', role: 'short' },
    // A fork of the long session, renamed and then worked on until the rename
    // lies far before the end of a large file (issue #51).
    { project: 'lab-alpha', title: 'Lab: renamed fork', role: 'fork' },
  ],
};
