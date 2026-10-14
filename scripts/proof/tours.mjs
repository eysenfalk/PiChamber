import { LAB_WORKER_TITLE } from '../lab/faux-orchestration.mjs';

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, mobile: false },
  mobile: { width: 390, height: 844, mobile: true },
};
/** Keys a tour may press, with their Windows virtual key codes for CDP. */
export const KEYS = { ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, Enter: 13, Escape: 27 };
export const validName = name => typeof name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(name);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const keys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const target = value => Number(nonempty(value.selector)) + Number(nonempty(value.text)) === 1;
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function validateTour(tour) {
  if (!tour || !validName(tour.name) || !keys(tour, ['name', 'steps']) || !Array.isArray(tour.steps) || !tour.steps.length) throw new Error('Invalid tour: name and nonempty steps required');
  tour.steps.forEach((step, index) => {
    const fail = () => { throw new Error('Invalid tour step ' + (index + 1)); };
    if (!step || !keys(step, ['caption', 'actions', 'evidence', 'viewport', 'theme']) || !nonempty(step.caption) || step.caption.length > 500 ||
        !Object.hasOwn(VIEWPORTS, step.viewport) || !['light', 'dark'].includes(step.theme) ||
        !Array.isArray(step.actions) || !Array.isArray(step.evidence) || !step.evidence.length) fail();
    for (const item of step.evidence) {
      if (!item || !keys(item, ['selector', 'text', 'index']) || (!nonempty(item.selector) && !nonempty(item.text)) ||
          (item.selector !== undefined && !nonempty(item.selector)) || (item.text !== undefined && !nonempty(item.text)) ||
          (item.index !== undefined && (!item.selector || !Number.isInteger(item.index) || item.index < 0))) fail();
    }
    for (const action of step.actions) {
      if (!action) fail();
      const schemas = {
        navigate: ['type', 'path'], click: ['type', 'selector', 'text', 'button'], type: ['type', 'selector', 'value'],
        press: ['type', 'key'], drag: ['type', 'from', 'to'],
        hover: ['type', 'selector', 'text'], 'long-press': ['type', 'selector', 'text'],
        scroll: ['type', 'selector', 'x', 'y'], wait: ['type', 'ms', 'selector', 'text'],
        'set-theme': ['type', 'theme'], 'set-viewport': ['type', 'viewport'],
      };
      if (!Object.hasOwn(schemas, action.type) || !keys(action, schemas[action.type])) fail();
      if (action.type === 'navigate' && (typeof action.path !== 'string' || (/^[a-z]+:/i.test(action.path) || action.path.startsWith('//')))) fail();
      if (action.type === 'click' && (!target(action) || ![undefined, 'right'].includes(action.button))) fail();
      if ((action.type === 'hover' || action.type === 'long-press') && !target(action)) fail();
      if (action.type === 'long-press' && !VIEWPORTS[step.viewport]?.mobile) fail();
      if (action.type === 'press' && (typeof action.key !== 'string' || !Object.hasOwn(KEYS, action.key))) fail();
      if (action.type === 'drag' && ![action.from, action.to].every(end => end && typeof end === 'object' && keys(end, ['selector', 'text']) && target(end))) fail();
      if (action.type === 'type' && (!nonempty(action.selector) || typeof action.value !== 'string')) fail();
      if (action.type === 'scroll' && (!nonempty(action.selector) || ((action.x !== undefined || action.y !== undefined) && (!finite(action.x ?? 0) || !finite(action.y ?? 0))))) fail();
      if (action.type === 'wait' && (action.ms !== undefined ? (!finite(action.ms) || action.ms < 0 || action.ms > 30000 || action.selector !== undefined || action.text !== undefined) : !target(action))) fail();
      if (action.type === 'set-theme' && !['light', 'dark'].includes(action.theme)) fail();
      if (action.type === 'set-viewport' && !Object.hasOwn(VIEWPORTS, action.viewport)) fail();
    }
  });
  return tour;
}

export const fixture = validateTour({ name: 'fixture', steps: [
  { caption: 'Fixture: projects and sessions.', viewport: 'desktop', theme: 'light',
    actions: [{ type: 'navigate', path: '' }], evidence: [{ selector: '#projects' }, { text: 'A prepared session' }] },
  { caption: 'Open the session and enter a note.', viewport: 'desktop', theme: 'light',
    actions: [{ type: 'click', selector: '#open' }, { type: 'type', selector: '#note', value: 'Recorded safely' }, { type: 'wait', text: 'Tool completed' }],
    evidence: [{ selector: '#session' }, { selector: '#note' }, { text: 'Tool completed' }] },
  { caption: 'Dark theme, same tool result.', viewport: 'desktop', theme: 'dark', actions: [],
    evidence: [{ selector: 'html.dark #session' }, { text: 'Tool completed' }] },
  { caption: 'Mobile sidebar, with touch emulation.', viewport: 'mobile', theme: 'dark',
    actions: [{ type: 'click', selector: '#mobile-open' }], evidence: [{ selector: '#projects' }, { text: 'A prepared session' }] },
] });
export const brokenFixture = validateTour({ name: 'fixture-broken', steps: [
  { caption: 'This clipped evidence must fail.', viewport: 'desktop', theme: 'light',
    actions: [{ type: 'navigate', path: '' }], evidence: [{ selector: '#clipped' }] },
] });

/** Names are owned by the lab seed manifest, not by the recorder. Display labels follow sidebar/utils.ts formatProjectLabel; selectors are checked by the lab tour. */
export function labTour(manifest) {
  const projects = manifest?.projects;
  const sessions = manifest?.sessions;
  const long = sessions?.find(session => session.role === 'long');
  const short = sessions?.find(session => session.role === 'short');
  if (!Array.isArray(projects) || projects.length < 2 || projects.some(project => !nonempty(project.name) || !nonempty(project.path)) ||
      !short || !nonempty(short.title) || !long || !nonempty(long.title) || !projects.some(project => project.name === long.project)) throw new Error('Invalid lab seed manifest');
  const label = name => name.replace(/[-_]/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
  const sidebar = [...projects.map(project => ({ text: label(project.name) })), { text: long.title }];
  const tool = { selector: '[data-chat-activity-row]', index: 0, text: 'Edit File' };
  return validateTour({ name: 'lab', steps: [
    { caption: 'Prepared projects and sessions in the lab sidebar.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'navigate', path: '' }, { type: 'wait', text: label(projects[0].name) }, { type: 'click', text: long.title }], evidence: sidebar },
    { caption: 'The long session includes an Edit File tool call.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', text: long.title }, { type: 'wait', selector: 'button[aria-label="Expand activity"]' },
        { type: 'scroll', selector: 'button[aria-label="Expand activity"]' }, { type: 'click', selector: 'button[aria-label="Expand activity"]' },
        { type: 'wait', selector: tool.selector }, { type: 'scroll', selector: tool.selector }], evidence: [tool] },
    { caption: 'The same tool call in dark theme.', viewport: 'desktop', theme: 'dark', actions: [],
      evidence: [tool].map(item => ({ ...item, selector: 'html.dark [data-chat-activity-row]' })) },
    { caption: 'Projects and sessions in the hosted mobile sidebar.', viewport: 'mobile', theme: 'dark',
      actions: [{ type: 'navigate', path: 'mobile.html' }, { type: 'wait', selector: 'button[aria-label="Open sessions and projects"]' },
        { type: 'click', selector: 'button[aria-label="Open sessions and projects"]' }],
      evidence: [{ selector: '[data-mobile-sessions-drawer] button[aria-pressed="true"]' },
        ...projects.map(project => ({ text: label(project.name) })), { text: short.title }] },
  ] });
}

/** Issue #51: a forked session whose rename lies 600 KiB before the end of its file, listed by a freshly started daemon. */
export function forkRenameTour(manifest) {
  const fork = manifest?.sessions?.find(session => session.role === 'fork');
  const project = manifest?.projects?.find(candidate => candidate.name === fork?.project);
  if (!fork || !nonempty(fork.title) || !project) throw new Error('Invalid lab seed manifest');
  const label = project.name.replace(/[-_]/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
  return validateTour({ name: 'fork-rename', steps: [
    { caption: `A freshly started daemon lists the renamed fork as "${fork.title}". The rename lies 600 KiB before the end of the session file.`,
      viewport: 'desktop', theme: 'light',
      actions: [{ type: 'navigate', path: '' }, { type: 'wait', text: label }, { type: 'wait', text: fork.title }],
      evidence: [{ text: label }, { text: fork.title }] },
    { caption: 'Opening the fork keeps its renamed title.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', text: fork.title }, { type: 'wait', ms: 1000 }], evidence: [{ text: fork.title }] },
    { caption: 'The hosted mobile sessions drawer shows the same name.', viewport: 'mobile', theme: 'dark',
      actions: [{ type: 'navigate', path: 'mobile.html' }, { type: 'wait', selector: 'button[aria-label="Open sessions and projects"]' },
        { type: 'click', selector: 'button[aria-label="Open sessions and projects"]' }, { type: 'wait', text: fork.title }],
      evidence: [{ text: fork.title }] },
  ] });
}

/** Issue #95: one workspace tree. Chats, projects with their worktrees, fork chains and other folders in one compact list. */
export function sidebarTreeTour(manifest) {
  const sessions = manifest?.sessions;
  const project = manifest?.projects?.find(candidate => candidate.name === manifest?.worktrees?.[0]?.project);
  const find = role => sessions?.find(session => session.role === role && nonempty(session.title));
  const [long, fork, forkChild, chat] = ['long', 'fork', 'fork-child', 'chat'].map(find);
  const others = manifest?.projects?.filter(candidate => candidate.name !== project?.name) ?? [];
  const otherSession = others[0] && sessions?.find(session => session.project === others[0].name && nonempty(session.title));
  const worktrees = sessions?.filter(session => session.role === 'worktree' && session.project === project?.name && nonempty(session.worktree)) ?? [];
  if (!project || !nonempty(project.path) || !long || !fork || !forkChild || !chat || worktrees.length < 2 || others.length < 2 || !others.every(other => nonempty(other.path)) || !otherSession) throw new Error('Invalid lab seed manifest');
  const titleCase = name => name.replace(/[-_]/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
  const label = titleCase(project.name);
  // Projects added by path get the id `path_` plus the base64url path.
  const projectId = other => `path_${Buffer.from(other.path).toString('base64url')}`;
  const projectNode = other => `[data-tree-node="p:${projectId(other)}"]`;
  const visibilityItem = other => `[role="menuitemcheckbox"][data-visibility-id="${projectId(other)}"]`;
  const search = 'input[aria-label="Search projects, branches and sessions"]';
  const hiddenTree = '[role="tree"]' + others.map(other => `:not(:has(${projectNode(other)}))`).join('');
  const row = key => `[data-tree-node="${key}"]`;
  const main = row(`w:${project.path}`);
  const expand = [
    { type: 'wait', text: label }, { type: 'click', text: label }, { type: 'wait', selector: main },
    { type: 'click', selector: main }, { type: 'wait', text: long.title },
  ];
  const folder = '[role="treeitem"][aria-label="Reviews"]';
  const nameField = 'input[aria-label="Folder name"]';
  const tree = [{ selector: '[role="tree"]' }, { text: 'Chats' }, { text: label }, { selector: `${main}[aria-expanded="true"]` },
    ...worktrees.map(worktree => ({ text: worktree.worktree })), { text: long.title }];
  // Git pills (slice 5): the seed puts each linked worktree into one git state.
  const gitRow = state => {
    const worktree = manifest.worktrees.find(candidate => candidate.git === state);
    if (!worktree) throw new Error(`Invalid lab seed manifest: no ${state} worktree`);
    return row(`w:${project.path}-worktrees/${worktree.name}`);
  };
  const pill = (rowSelector, label) => ({ selector: `${rowSelector} [aria-label${label.endsWith('*') ? '^' : ''}="${label.replace(/\*$/, '')}"]` });
  const pills = [
    pill(gitRow('dirty'), '2 changed files'), pill(gitRow('dirty'), '1 commit to pull*'),
    pill(gitRow('ahead-behind'), '2 commits to push*'), pill(gitRow('ahead-behind'), '1 commit to pull*'), pill(gitRow('ahead-behind'), 'All committed'),
    pill(gitRow('rebase'), 'Rebase in progress'), pill(main, 'No upstream branch'),
  ];
  const projectRollup = pill(projectNode(project), '2 worktrees have uncommitted changes');
  // Auto fetch (slice 6): the seed pushes a commit to fetch-me's remote that the checkout has not fetched yet.
  const fetchMe = gitRow('remote-ahead');
  const fetched = pill(fetchMe, '1 commit to pull*');
  const autoFetch = '[data-settings-item="git.auto-fetch"]';
  // Quick create (slice 7): the `+` shows on hover over the row's count slot, as a sibling of the row button.
  const plus = rowSelector => `${rowSelector} ~ button[aria-label^="New session in"]`;
  const composerFocused = { selector: '[data-chat-input="true"] .cm-content:focus' };
  // `target` is the directory chip the new draft shows; the composer may already have focus from an earlier step.
  const quickCreate = (rowSelector, target) => [{ type: 'hover', selector: rowSelector }, { type: 'wait', ms: 200 }, { type: 'click', selector: plus(rowSelector) },
    ...(target ? [{ type: 'wait', text: target }] : []), { type: 'wait', selector: composerFocused.selector }];
  const flat = projectNode(others[0]);
  return validateTour({ name: 'sidebar-tree', steps: [
    { caption: 'One tree instead of two areas: Chats on top, then projects. Nothing is expanded yet.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'navigate', path: '' }, { type: 'wait', selector: '[role="tree"]' }, { type: 'wait', text: label }],
      evidence: [{ selector: '[role="tree"]' }, { text: 'Chats' }, { text: label }] },
    { caption: `Clicking ${label} selects and expands it and shows its worktrees. Clicking main shows its sessions.`, viewport: 'desktop', theme: 'light',
      actions: expand, evidence: tree },
    { caption: 'Each worktree shows its git state: ●2 uncommitted files, ↑2 ↓1 against main, ✓ all committed, a warning while a rebase is stopped, a cloud where main has no upstream.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'wait', selector: pills[0].selector }, { type: 'wait', selector: pills[5].selector }],
      evidence: [...pills, { selector: `${fetchMe}:not(:has([aria-label^="1 commit to pull"]))` }] },
    { caption: 'Settings > Git has Auto fetch, off by default. Turning it on fetches every 15 minutes, without ever asking for credentials.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'navigate', path: '?settings=git' }, { type: 'wait', selector: `${autoFetch}[aria-pressed="false"]` },
        { type: 'click', selector: autoFetch }, { type: 'wait', selector: `${autoFetch}[aria-pressed="true"]` }],
      evidence: [{ selector: `${autoFetch}[aria-pressed="true"]` }, { text: 'Auto fetch interval' }, { text: '15 min' }] },
    { caption: 'Back in the tree, fetch-me shows ↓1: the commit pushed to its remote arrived without a manual fetch.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'navigate', path: '' }, { type: 'wait', selector: main }, { type: 'wait', selector: fetched.selector }],
      evidence: [fetched, { text: long.title }] },
    { caption: 'Hovering a row swaps its count for a +. The + on Chats starts a chat without a project folder and puts the cursor in the composer.', viewport: 'desktop', theme: 'light',
      actions: quickCreate(row('chats')), evidence: [{ selector: plus(row('chats')) }, composerFocused] },
    { caption: `The + on main starts a session in ${project.name} main.`, viewport: 'desktop', theme: 'light',
      actions: quickCreate(main, project.name), evidence: [{ selector: plus(main) }, { text: project.name }, composerFocused] },
    { caption: `${titleCase(others[0].name)} has one checkout, so its project row takes the + itself. The click also selects the row.`, viewport: 'desktop', theme: 'light',
      actions: quickCreate(flat, others[0].name), evidence: [{ selector: plus(flat) }, { selector: `${flat}[aria-current="true"]` }, { text: others[0].name }, composerFocused] },
    { caption: 'Forks sit under their parent session, with a fork count.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', selector: 'button[aria-label="Expand forks"]' }, { type: 'wait', text: fork.title },
        { type: 'click', selector: 'button[aria-label="Expand forks"]' }, { type: 'wait', text: forkChild.title }],
      evidence: [{ text: long.title }, { text: fork.title }, { text: forkChild.title }, { selector: '[aria-label="1 fork"]' }] },
    { caption: 'Right-click a worktree for New folder. The folder is named in place and sits under main.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', selector: main, button: 'right' }, { type: 'wait', text: 'New folder' }, { type: 'click', text: 'New folder' },
        { type: 'wait', selector: nameField }, { type: 'type', selector: nameField, value: 'Reviews' }, { type: 'press', key: 'Enter' }, { type: 'wait', selector: folder }],
      evidence: [{ selector: `${folder}[aria-level="3"]` }, { text: 'Reviews' }] },
    { caption: `Dragging ${long.title} onto Reviews moves it into the folder; clicking the folder opens it.`, viewport: 'desktop', theme: 'light',
      actions: [{ type: 'drag', from: { text: long.title }, to: { selector: folder } }, { type: 'wait', selector: `${folder}[aria-expanded]` },
        // dnd-kit swallows clicks for a moment after a drop; a person never clicks that fast.
        { type: 'wait', ms: 300 }, { type: 'click', text: 'Reviews' }, { type: 'wait', selector: `${folder}[aria-expanded="true"]` }],
      evidence: [{ selector: `${folder}[aria-expanded="true"]` }, // The fork toggle proves the level without asking a deep, ellipsized title to fit.
        { selector: `[role="treeitem"][aria-level="4"][aria-label="${long.title}"] [data-tree-toggle]` }] },
    { caption: 'Arrow keys walk the tree: down to the session, left closes its forks, left again climbs to the folder and closes it.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'press', key: 'ArrowDown' }, { type: 'wait', selector: `[role="treeitem"][aria-label="${long.title}"]:focus` },
        { type: 'press', key: 'ArrowLeft' }, { type: 'press', key: 'ArrowLeft' }, { type: 'press', key: 'ArrowLeft' }],
      evidence: [{ selector: `${folder}[aria-expanded="false"]:focus` }, { text: 'Reviews' }] },
    { caption: 'Chats holds sessions started without a project, in the home directory.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', text: 'Chats' }, { type: 'wait', text: chat.title }],
      evidence: [{ selector: `${row('chats')}[aria-expanded="true"]` }, { text: chat.title }] },
    { caption: `The eye menu picks the shown projects. Unchecking ${others.map(other => titleCase(other.name)).join(' and ')} removes them from the tree.`, viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', selector: 'button[aria-label^="Shown projects"]' }, { type: 'wait', text: 'Show in sidebar' },
        ...others.flatMap(other => [{ type: 'click', selector: visibilityItem(other) }, { type: 'wait', selector: `${visibilityItem(other)}[aria-checked="false"]` }])],
      evidence: [{ text: 'Show in sidebar' }, ...others.map(other => ({ selector: `${visibilityItem(other)}[aria-checked="false"]` })),
        { selector: `button[aria-label="Shown projects, ${others.length} hidden"]` }] },
    { caption: 'The tree keeps Chats and the shown project only.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'press', key: 'Escape' }, { type: 'wait', selector: hiddenTree }],
      evidence: [{ selector: hiddenTree }, { text: 'Chats' }, { text: label }] },
    { caption: `Searching a branch name narrows the tree to that worktree and opens the path to it.`, viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', selector: 'button[aria-label="Search"]' }, { type: 'wait', selector: search },
        { type: 'type', selector: search, value: worktrees[1].worktree }, { type: 'wait', text: '1 match' }],
      evidence: [{ text: '1 match' }, { selector: `[role="treeitem"] mark` }, { text: worktrees[1].worktree }] },
    { caption: `The search also finds sessions in hidden projects; the count line and the eye mark say the project is hidden.`, viewport: 'desktop', theme: 'light',
      actions: [{ type: 'type', selector: search, value: otherSession.title }, { type: 'wait', selector: '[aria-label="Matches in 1 hidden project"]' }],
      evidence: [{ selector: `${projectNode(others[0])} [aria-label="Hidden from the sidebar"]` }, { selector: '[aria-label="Matches in 1 hidden project"]' }, { text: otherSession.title }] },
    { caption: 'Escape clears the search, a second Escape closes it, and the tree is back as it was.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'press', key: 'Escape' }, { type: 'press', key: 'Escape' }, { type: 'wait', selector: hiddenTree }],
      evidence: [{ selector: hiddenTree }, { selector: `${folder}[aria-expanded="false"]` }, { text: chat.title }] },
    { caption: 'The same tree in dark theme.', viewport: 'desktop', theme: 'dark', actions: [],
      evidence: [{ selector: 'html.dark [role="tree"]' }, { text: chat.title }, { text: 'Reviews' }] },
    { caption: `Collapsed, ${label} sums its worktrees up as "2 dirty".`, viewport: 'desktop', theme: 'dark',
      actions: [{ type: 'click', selector: `${projectNode(project)} [data-tree-toggle]` }, { type: 'wait', selector: projectRollup.selector }],
      evidence: [projectRollup, { selector: `${projectNode(project)}[aria-expanded="false"]` }] },
    { caption: 'The hosted mobile drawer shows the same tree.', viewport: 'mobile', theme: 'dark',
      actions: [{ type: 'navigate', path: 'mobile.html' }, { type: 'wait', selector: 'button[aria-label="Open sessions and projects"]' },
        { type: 'click', selector: 'button[aria-label="Open sessions and projects"]' }, { type: 'wait', selector: '[data-mobile-sessions-drawer] [role="tree"]' }],
      evidence: [{ selector: `[data-mobile-sessions-drawer] ${row('chats')}` }, { text: 'Chats' }, { text: label }] },
    { caption: 'Mobile in light theme.', viewport: 'mobile', theme: 'light', actions: [],
      evidence: [{ selector: `[data-mobile-sessions-drawer] ${row('chats')}` }, { text: label }] },
    { caption: 'Touch has no hover, so the + is not there. A long press on Chats opens its menu with New session.', viewport: 'mobile', theme: 'light',
      actions: [{ type: 'long-press', selector: `[data-mobile-sessions-drawer] ${row('chats')}` }, { type: 'wait', text: 'New session' }],
      evidence: [{ selector: '[role="menuitem"]' }, { text: 'New session' }] },
    { caption: 'New session closes the drawer and opens an empty chat.', viewport: 'mobile', theme: 'light',
      actions: [{ type: 'click', text: 'New session' }, { type: 'wait', selector: '[data-chat-input="true"]' }],
      evidence: [{ selector: '[data-chat-input="true"]' }] },
  ] });
}

/** Issue #107: an orchestrator on the scripted faux model spawns a worker, stays responsive, the owner writes into the worker and the result returns. */
export function orchestrationTour(manifest) {
  const orchestrator = manifest?.sessions?.find(session => session.role === 'orchestrator' && nonempty(session.title));
  const project = manifest?.projects?.find(candidate => candidate.name === orchestrator?.project);
  if (!orchestrator || !project || !nonempty(project.path)) throw new Error('Invalid lab seed manifest');
  const label = project.name.replace(/[-_]/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
  const worker = LAB_WORKER_TITLE;
  const composer = '[data-chat-input="true"] .cm-content';
  const say = value => [{ type: 'type', selector: composer, value }, { type: 'press', key: 'Enter' }];
  const item = title => `[role="treeitem"][aria-label="${title}"]`;
  const card = '[data-orchestration-result]';
  const limit = '[data-settings-item="sessions.orchestration-worker-limit"]';
  const picker = role => `[aria-label="${role} model"]`;
  return validateTour({ name: 'orchestration', steps: [
    { caption: 'Settings, Sessions: the worker limit and the model and thinking level of each worker role.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'navigate', path: '?settings=sessions' }, { type: 'wait', selector: picker('Review') }, { type: 'scroll', selector: limit }],
      evidence: [{ selector: limit }, { text: 'Worker roles' }, { selector: picker('Orchestrate') }] },
    { caption: 'Further down: the four task levels, research, small tasks and review.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'scroll', selector: picker('Research') }],
      evidence: ['Task, easy', 'Task, extreme', 'Small tasks', 'Review'].map(role => ({ selector: picker(role) })) },
    { caption: `The orchestrator asks for a worker. session_spawn starts "${worker}" in ${label}, and the orchestrator turn ends at once.`, viewport: 'desktop', theme: 'light',
      actions: [{ type: 'navigate', path: '' }, { type: 'wait', text: label }, { type: 'click', text: label },
        { type: 'click', selector: `[data-tree-node="w:${project.path}"]` }, { type: 'wait', selector: item(orchestrator.title) },
        { type: 'click', selector: item(orchestrator.title) }, { type: 'wait', selector: composer },
        ...say('ORCHESTRATE'), { type: 'wait', text: 'I stay available while it works.' }],
      evidence: [{ selector: item(orchestrator.title) }, { text: 'I stay available while it works.' }] },
    { caption: 'While the worker still runs, the owner asks the orchestrator and gets an answer right away.', viewport: 'desktop', theme: 'light',
      actions: [...say('STATUS?'), { type: 'wait', text: 'I can answer you meanwhile.' }],
      evidence: [{ text: 'I can answer you meanwhile.' }] },
    { caption: 'The worker sits under its orchestrator in the sidebar. Its question returns as a compact result card.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', selector: `${item(orchestrator.title)} button[aria-label="Expand forks"]` }, { type: 'wait', selector: item(worker) },
        { type: 'wait', selector: card }, { type: 'wait', text: 'Write GO in its session.' }],
      evidence: [{ selector: item(worker) }, { selector: card }, { text: 'Write GO in its session.' }] },
    { caption: 'The owner opens the worker from the card and writes into it directly.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', selector: `button[aria-label="Open worker ${worker}"]` }, { type: 'wait', text: 'I need your go: reply GO.' },
        ...say('GO'), { type: 'wait', text: 'WORKER DONE' }],
      evidence: [{ text: 'I need your go: reply GO.' }, { text: 'WORKER DONE' }] },
    { caption: 'Back in the orchestrator, the second result card carries the finished work.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', selector: item(orchestrator.title) }, { type: 'wait', text: 'Nothing else is open.' }],
      evidence: [{ selector: card, index: 1 }, { text: 'Nothing else is open.' }] },
    { caption: 'The same transcript in dark theme.', viewport: 'desktop', theme: 'dark', actions: [],
      evidence: [{ selector: `html.dark ${card}` }, { text: 'Nothing else is open.' }] },
    { caption: 'The hosted mobile drawer nests the worker under the orchestrator too.', viewport: 'mobile', theme: 'dark',
      actions: [{ type: 'navigate', path: 'mobile.html' }, { type: 'wait', selector: 'button[aria-label="Open sessions and projects"]' },
        { type: 'click', selector: 'button[aria-label="Open sessions and projects"]' }, { type: 'wait', selector: `[data-mobile-sessions-drawer] ${item(worker)}` }],
      // The narrow drawer truncates the orchestrator title, so the nesting is proven by the worker's tree level: project 1, worktree 2, orchestrator 3.
      evidence: [{ selector: `[data-mobile-sessions-drawer] ${item(worker)}[aria-level="4"]` }] },
  ] });
}

/** Issue #147: Pi custom messages (intercom, subagent notices, an unknown extension) as compact rows in the chat column. */
export function extensionMessagesTour(manifest) {
  const session = manifest?.sessions?.find(candidate => candidate.role === 'extensions');
  const project = manifest?.projects?.find(candidate => candidate.name === session?.project);
  if (!session || !nonempty(session.title) || !project) throw new Error('Invalid lab seed manifest');
  const label = project.name.replace(/[-_]/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
  const item = `[role="treeitem"][aria-label="${session.title}"]`;
  // The assistant's last answer: visible at the bottom of the session on every build.
  const secondTurn = { text: 'The background checks are running.' };
  // The project has one checkout, so its sessions sit directly under the project row.
  const open = [{ type: 'navigate', path: '' }, { type: 'wait', text: label }, { type: 'click', text: label }, { type: 'wait', selector: item },
    { type: 'click', selector: item }, { type: 'wait', text: secondTurn.text }];
  // Lab Beta stays expanded from the first step; clicking its row again would collapse it.
  const reopen = [{ type: 'navigate', path: '' }, { type: 'wait', selector: item }, { type: 'click', selector: item }, { type: 'wait', text: secondTurn.text }];
  // Hosted mobile opens the session the desktop steps selected.
  const openMobile = [{ type: 'navigate', path: 'mobile.html' }, { type: 'wait', text: secondTurn.text }];
  const run = '[data-extension-run="9"][data-extension-type="intercom_message"]';
  const message = `${run} [data-extension-disclosure="expanded"]`;
  const rows = [{ text: '9 Intercom messages' }, { text: '3 Subagent notify messages' }, { text: 'Lab context note' }];
  // The first two steps hold on any build, so a build before #147 records the same view and fails only at step 3.
  return validateTour({ name: 'extension-messages', steps: [
    { caption: `"${session.title}": nine intercom messages, three subagent notices and one message of an unknown extension, between two turns.`,
      viewport: 'desktop', theme: 'light', actions: open, evidence: [secondTurn] },
    { caption: 'The same session in the hosted mobile layout.', viewport: 'mobile', theme: 'light',
      actions: openMobile, evidence: [secondTurn] },
    { caption: 'Each kind of custom message is one compact row in the chat column: the nine intercom messages, the three subagent notices and the unknown extension.',
      viewport: 'desktop', theme: 'light', actions: reopen, evidence: [...rows, { selector: `.chat-message-column ${run}` }] },
    { caption: 'Expanding the intercom row lists each message by sender. Expanding one renders its text as Markdown: bold, emphasis and code, no raw stars.',
      viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', selector: `${run} > button` }, { type: 'wait', selector: `${run} [data-extension-type="intercom_message"]` },
        { type: 'click', selector: `${run} button[aria-label="Intercom message: From #137 mobile composer (task-medium)"]` },
        { type: 'wait', selector: `${message} code` }, { type: 'scroll', selector: `${message} code` }],
      evidence: [{ selector: `${message} strong`, index: 1, text: 'passed' }, { selector: `${message} code`, text: 'bun run test' },
        { text: 'Intercom' }] },
    { caption: 'The same expanded messages in dark theme.', viewport: 'desktop', theme: 'dark', actions: [],
      evidence: [{ selector: `html.dark ${message} code`, text: 'bun run test' }] },
    { caption: 'In the hosted mobile layout the rows stay inside the column.', viewport: 'mobile', theme: 'dark',
      actions: openMobile, evidence: [rows[0], rows[1]] },
  ] });
}

/** Issue #46: the create-device dialog on a server without Tailscale (the lab pod has none) keeps the home network as default. */
export function addDeviceTour() {
  // Desktop opens Settings from the URL; hosted mobile ignores `?settings=` and goes through the drawer.
  const open = {
    desktop: [{ type: 'navigate', path: '?settings=remote-instances' }, { type: 'wait', text: 'Add a device' }, { type: 'click', text: 'Add a device' }],
    mobile: [{ type: 'navigate', path: 'mobile.html' }, { type: 'wait', selector: 'button[aria-label="Open sessions and projects"]' },
      { type: 'click', selector: 'button[aria-label="Open sessions and projects"]' }, { type: 'wait', selector: '[data-mobile-sessions-drawer]' },
      { type: 'wait', ms: 800 }, { type: 'click', selector: 'button[aria-label="Settings"]' },
      { type: 'wait', text: 'Manage instances & pair devices' }, { type: 'click', text: 'Manage instances & pair devices' },
      { type: 'wait', text: 'Add a device' }, { type: 'click', text: 'Add a device' }],
  };
  const dialog = theme => [
    { selector: (theme === 'dark' ? 'html.dark ' : '') + '[role="radio"][aria-label="Home network only"][aria-checked="true"]' },
    { selector: '[role="radio"][aria-label="Tailscale (recommended)"][aria-checked="false"]:disabled' },
    { text: 'Not available. Start Tailscale on this computer and allow network access to PiChamber.' },
  ];
  const step = (viewport, theme) => ({
    caption: `Without Tailscale on the server, Add a device selects Home network only and greys out Tailscale (${viewport}, ${theme}).`,
    viewport, theme, actions: [...open[viewport], { type: 'wait', text: 'Where will you use this device?' }], evidence: dialog(theme),
  });
  return validateTour({ name: 'add-device', steps: [step('desktop', 'light'), step('desktop', 'dark'), step('mobile', 'light'), step('mobile', 'dark')] });
}
