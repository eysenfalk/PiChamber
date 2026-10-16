import { LAB_ASKER_BLOCKER, LAB_ASKER_OPTIONS, LAB_ASKER_QUESTION, LAB_ASKER_TITLE, LAB_CHOOSER_DIALOGS, LAB_CHOOSER_TITLE, LAB_HTML_RENDER_PROMPT, LAB_HTML_RENDER_REPLY, LAB_HTML_RENDER_TITLE, LAB_REVIEW_WORKER_TITLE, LAB_WORKER_TITLE, LAB_WORKTREE_WORKER } from '../lab/faux-orchestration.mjs';

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
  // The daemon wakes the orchestrator with one pichamber.orchestration.events message per burst.
  const wake = '[data-extension-type="pichamber.orchestration.events"]';
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
    { caption: 'The worker sits under its orchestrator in the sidebar. Its question wakes the orchestrator as one compact row.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', selector: `${item(orchestrator.title)} button[aria-label="Expand forks"]` }, { type: 'wait', selector: item(worker) },
        { type: 'wait', selector: wake }, { type: 'wait', text: 'Write GO in its session.' }],
      evidence: [{ selector: item(worker) }, { selector: wake }, { text: 'Write GO in its session.' }] },
    { caption: 'The owner opens the worker from the sidebar and writes into it directly.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', selector: item(worker) }, { type: 'wait', text: 'I need your go: reply GO.' },
        ...say('GO'), { type: 'wait', text: 'WORKER DONE' }],
      evidence: [{ text: 'I need your go: reply GO.' }, { text: 'WORKER DONE' }] },
    { caption: 'Back in the orchestrator, the worker reports done and wakes it a second time.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', selector: item(orchestrator.title) }, { type: 'wait', text: 'Nothing else is open.' }],
      evidence: [{ selector: wake, index: 1 }, { text: 'Nothing else is open.' }] },
    { caption: 'The same transcript in dark theme.', viewport: 'desktop', theme: 'dark', actions: [],
      evidence: [{ selector: `html.dark ${wake}` }, { text: 'Nothing else is open.' }] },
    { caption: 'The hosted mobile drawer nests the worker under the orchestrator too.', viewport: 'mobile', theme: 'dark',
      actions: [{ type: 'navigate', path: 'mobile.html' }, { type: 'wait', selector: 'button[aria-label="Open sessions and projects"]' },
        { type: 'click', selector: 'button[aria-label="Open sessions and projects"]' }, { type: 'wait', selector: `[data-mobile-sessions-drawer] ${item(worker)}` }],
      // The narrow drawer truncates the orchestrator title, so the nesting is proven by the worker's tree level: project 1, worktree 2, orchestrator 3.
      evidence: [{ selector: `[data-mobile-sessions-drawer] ${item(worker)}[aria-level="4"]` }] },
  ] });
}

/** Issue #151: the orchestrator starts a review worker; its read-only tool profile keeps edit and write away, and the README stays unchanged. */
export function toolProfilesTour(manifest) {
  const orchestrator = manifest?.sessions?.find(session => session.role === 'orchestrator' && nonempty(session.title));
  const project = manifest?.projects?.find(candidate => candidate.name === orchestrator?.project);
  if (!orchestrator || !project || !nonempty(project.path)) throw new Error('Invalid lab seed manifest');
  const label = project.name.replace(/[-_]/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
  const worker = LAB_REVIEW_WORKER_TITLE;
  const composer = '[data-chat-input="true"] .cm-content';
  const item = title => `[role="treeitem"][aria-label="${title}"]`;
  const started = { text: 'runs with the read-only profile.' };
  const verdict = { text: 'could not change README.md' };
  const done = { text: 'REVIEW DONE.' };
  return validateTour({ name: 'tool-profiles', steps: [
    { caption: `The orchestrator starts the review worker "${worker}". Its own answer lists the tools sent to it: no profile, so the full set with edit and write.`, viewport: 'desktop', theme: 'light',
      actions: [{ type: 'navigate', path: '' }, { type: 'wait', text: label }, { type: 'click', text: label },
        { type: 'click', selector: `[data-tree-node="w:${project.path}"]` }, { type: 'wait', selector: item(orchestrator.title) },
        { type: 'click', selector: item(orchestrator.title) }, { type: 'wait', selector: composer },
        { type: 'type', selector: composer, value: 'REVIEW' }, { type: 'press', key: 'Enter' }, { type: 'wait', ...started }],
      evidence: [started, { text: 'Tools sent to me (orchestrator, no profile, full)' }] },
    { caption: 'The review worker ends. Its result wakes the orchestrator, which reports that the worker could not change README.md.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'wait', ...verdict }],
      evidence: [{ text: 'A worker event:' }, verdict] },
    { caption: 'In the worker: edit and write fail, git reports README.md unchanged, and the tools sent to the worker lack edit and write.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', selector: `${item(orchestrator.title)} button[aria-label="Expand forks"]` }, { type: 'wait', selector: item(worker) },
        { type: 'click', selector: item(worker) }, { type: 'wait', ...done }],
      evidence: [done, { text: 'git: README.md unchanged' }, { text: 'Tools sent to me (review worker, profile read-only)' }] },
    { caption: 'The same worker transcript in dark theme.', viewport: 'desktop', theme: 'dark', actions: [],
      evidence: [{ selector: 'html.dark [data-chat-input="true"]' }, done] },
  ] });
}

/**
 * Issue #20, #87, #210: a worker asks the owner; the control center lists the workers, and its decision
 * inbox shows the full brief, answers the question with an option button and the blocker after it with free text.
 */
export function controlCenterTour(manifest) {
  const orchestrator = manifest?.sessions?.find(session => session.role === 'orchestrator' && nonempty(session.title));
  const project = manifest?.projects?.find(candidate => candidate.name === orchestrator?.project);
  if (!orchestrator || !project || !nonempty(project.path)) throw new Error('Invalid lab seed manifest');
  const label = project.name.replace(/[-_]/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
  const worker = LAB_ASKER_TITLE;
  const chooser = LAB_CHOOSER_TITLE;
  const [license, badge] = LAB_CHOOSER_DIALOGS;
  const composer = '[data-chat-input="true"] .cm-content';
  const item = title => `[role="treeitem"][aria-label="${title}"]`;
  const inbox = '[aria-label="Decision inbox"]';
  const row = `button[aria-label="Open ${worker}"]`;
  const chooserRow = `button[aria-label="Open ${chooser}"]`;
  const waiting = 'button[aria-label="Open control center, 1 decision waiting"]';
  const waitingTwo = 'button[aria-label="Open control center, 2 decisions waiting"]';
  const desktopEntry = 'button[aria-label^="Open control center"]';
  const inboxDialog = `${inbox} [data-inbox-dialog]`;
  const chatDialog = `[role="dialog"][aria-label="${license.title}"]`;
  const closeOne = 'button[aria-label="Close control center, 1 decision waiting"]';
  const chosen = { text: `Chosen: ${license.options[1]} and ${badge.options[0]}.` };
  const mobileEntry = 'button[aria-label^="Open control center"]';
  const choice = LAB_ASKER_OPTIONS.find(option => option.recommended).label;
  const option = `${inbox} [data-inbox-option="${choice}"]`;
  const blocker = { selector: `${inbox} [data-inbox-question]`, text: LAB_ASKER_BLOCKER };
  const answer = 'ANSWER: keep the copy';
  const empty = { text: 'No open questions or dialogs.' };
  return validateTour({ name: 'control-center', steps: [
    { caption: `The orchestrator starts "${worker}", which asks the owner a question. The orchestrator leaves owner questions to the owner, and the header counts one waiting decision.`, viewport: 'desktop', theme: 'light',
      actions: [{ type: 'navigate', path: '' }, { type: 'wait', text: label }, { type: 'click', text: label },
        { type: 'click', selector: `[data-tree-node="w:${project.path}"]` }, { type: 'wait', selector: item(orchestrator.title) },
        { type: 'click', selector: item(orchestrator.title) }, { type: 'wait', selector: composer },
        { type: 'type', selector: composer, value: 'ASK' }, { type: 'press', key: 'Enter' }, { type: 'wait', text: 'I leave that question to you.' }, { type: 'wait', selector: waiting }],
      evidence: [{ text: `The worker "${worker}" is running.` }, { text: 'I leave that question to you.' }, { selector: waiting }] },
    { caption: `A second worker, "${chooser}", opens an extension dialog; the orchestrator leaves it to the owner and the header counts two waiting decisions.`, viewport: 'desktop', theme: 'light',
      actions: [{ type: 'type', selector: composer, value: 'CHOOSE' }, { type: 'press', key: 'Enter' }, { type: 'wait', text: 'I leave that dialog to you.' }, { type: 'wait', selector: waitingTwo }],
      evidence: [{ text: 'I leave that dialog to you.' }, { selector: waitingTwo }] },
    { caption: `The owner opens "${chooser}" from the control center, which shows its dialog in its own chat only (#215), picks ${license.options[1]} there and goes back to the orchestrator. The control center shows the question as its title with the context, three options as answer buttons with their consequence, the recommended one marked, and what the worker does until then.`, viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', selector: desktopEntry }, { type: 'wait', selector: chooserRow }, { type: 'scroll', selector: chooserRow }, { type: 'click', selector: chooserRow }, { type: 'wait', selector: chatDialog },
        { type: 'click', text: license.options[1] }, { type: 'wait', ms: 1000 }, { type: 'click', selector: item(orchestrator.title) }, { type: 'wait', selector: composer }, { type: 'click', selector: desktopEntry },
        { type: 'wait', selector: `${inbox} [data-inbox-question]` }, { type: 'wait', text: badge.title }, { type: 'wait', selector: chooserRow }],
      evidence: [{ selector: '[aria-label="Slots and host"]' }, { selector: `${inbox} [data-inbox-question]`, text: LAB_ASKER_QUESTION }, { selector: option, text: 'Recommended' },
        { selector: `${inbox} [data-inbox-option]`, index: 2, text: LAB_ASKER_OPTIONS[2].consequence }, { text: 'Until then:' }] },
    { caption: 'Further down the control center lists the chooser\'s next dialog and both workers under their orchestrator.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'scroll', selector: chooserRow }],
      evidence: [{ selector: inboxDialog, text: badge.title }, { selector: row }, { selector: chooserRow }] },
    { caption: `The owner picks "${badge.options[0]}" in the inbox without opening the chooser. Only the question is left.`, viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', text: badge.options[0] }, { type: 'wait', selector: closeOne }],
      evidence: [{ selector: closeOne }, { selector: `${inbox} [data-inbox-question]`, text: LAB_ASKER_QUESTION }] },
    { caption: 'On the phone the same question stacks its options full width, each with its consequence, so one tap answers.', viewport: 'mobile', theme: 'light',
      actions: [{ type: 'navigate', path: 'mobile.html' }, { type: 'wait', selector: mobileEntry }, { type: 'click', selector: mobileEntry },
        { type: 'wait', selector: option }],
      // The whole card is taller than a phone, so the evidence is its title and the visible options.
      evidence: [{ text: LAB_ASKER_QUESTION }, { selector: option, text: 'Recommended' },
        { selector: `${inbox} [data-inbox-option]`, index: 1, text: LAB_ASKER_OPTIONS[1].consequence }] },
    { caption: `One tap on "${choice}" answers: the label goes to the worker as the owner's prompt and closes the question. The worker then reports a blocker for the owner, with what it tried and what it needs.`, viewport: 'desktop', theme: 'light',
      actions: [{ type: 'navigate', path: '' }, { type: 'wait', selector: item(orchestrator.title) }, { type: 'click', selector: item(orchestrator.title) },
        { type: 'wait', selector: composer }, { type: 'click', selector: waiting }, { type: 'wait', selector: option }, { type: 'click', selector: option }, { type: 'wait', text: LAB_ASKER_BLOCKER }],
      evidence: [blocker, { text: 'Tried' }, { text: 'Needed' }] },
    { caption: 'Opening the worker from the control center shows the option answer in its transcript.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'scroll', selector: row }, { type: 'click', selector: row }, { type: 'wait', text: `Got your answer (${choice}).` }],
      evidence: [{ text: `Got your answer (${choice}).` }] },
    { caption: 'Opening the chooser from the session list shows both answers in its transcript, the one from the chat and the one from the inbox.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'wait', selector: item(chooser) }, { type: 'click', selector: item(chooser) }, { type: 'wait', ...chosen }],
      evidence: [chosen] },
    { caption: 'The session list filter shows only workers.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', selector: '[data-testid="worker-filter-trigger"]' }, { type: 'wait', selector: '[data-worker-filter="only"]' },
        { type: 'click', selector: '[data-worker-filter="only"]' }, { type: 'wait', selector: 'button[aria-label="Workers: only workers"]' }],
      evidence: [{ selector: 'button[aria-label="Workers: only workers"]' }, { selector: item(worker) }, { selector: item(chooser) }] },
    { caption: 'The control center in dark theme, with the blocker open.', viewport: 'desktop', theme: 'dark',
      actions: [{ type: 'click', selector: waiting }, { type: 'wait', selector: `${inbox} [data-inbox-question]` }],
      evidence: [{ selector: `html.dark ${inbox} [data-inbox-question]`, text: LAB_ASKER_BLOCKER }, { selector: row }] },
    { caption: 'Hosted mobile opens the control center full screen from its header, with the blocker and its brief.', viewport: 'mobile', theme: 'light',
      actions: [{ type: 'navigate', path: 'mobile.html' }, { type: 'wait', selector: mobileEntry }, { type: 'click', selector: mobileEntry },
        { type: 'wait', selector: `${inbox} [data-inbox-question]` }],
      evidence: [{ selector: mobileEntry }, blocker, { text: 'Needed' }, { text: 'Until then:' }] },
    { caption: 'On the phone in dark theme, the owner answers the blocker with free text. The answer goes to the worker and closes the blocker; nothing waits for the owner any more.', viewport: 'mobile', theme: 'dark',
      actions: [{ type: 'navigate', path: 'mobile.html' }, { type: 'wait', selector: mobileEntry }, { type: 'click', selector: mobileEntry },
        { type: 'wait', selector: `${inbox} [data-inbox-question]` }, { type: 'type', selector: `textarea[aria-label="Answer to ${worker}"]`, value: answer },
        { type: 'click', text: 'Send answer' }, { type: 'wait', ...empty }],
      // The row's last report line truncates on a phone by design, so the evidence is the worker's name.
      evidence: [empty, { text: 'nothing waits for you' }, { text: worker }] },
  ] });
}

/** Issue #179: a worker the orchestrator spawns in a linked worktree sits under that worktree, not under its orchestrator in main. */
export function worktreeWorkerTour(manifest) {
  const orchestrator = manifest?.sessions?.find(session => session.role === 'orchestrator' && nonempty(session.title));
  const project = manifest?.projects?.find(candidate => candidate.name === orchestrator?.project);
  if (!orchestrator || !project || !nonempty(project.path)) throw new Error('Invalid lab seed manifest');
  const label = project.name.replace(/[-_]/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
  const { title: worker, worktree } = LAB_WORKTREE_WORKER;
  const composer = '[data-chat-input="true"] .cm-content';
  const item = title => `[role="treeitem"][aria-label="${title}"]`;
  const worktreeRow = `[data-tree-node="w:${project.path}-worktrees/${worktree}"]`;
  // Tree levels: project 1, worktree 2, session 3. A worker nested under its orchestrator would be at 4.
  const placed = `${item(worker)}[aria-level="3"]`;
  const reply = `runs in the worktree ${worktree}.`;
  return validateTour({ name: 'worktree-worker', steps: [
    { caption: `The orchestrator in ${label}, main, starts "${worker}" through session_spawn in the linked worktree ${worktree}.`, viewport: 'desktop', theme: 'light',
      actions: [{ type: 'navigate', path: '' }, { type: 'wait', text: label }, { type: 'click', text: label },
        { type: 'click', selector: `[data-tree-node="w:${project.path}"]` }, { type: 'wait', selector: item(orchestrator.title) },
        { type: 'click', selector: item(orchestrator.title) }, { type: 'wait', selector: composer },
        { type: 'type', selector: composer, value: 'ORCHESTRATE WORKTREE' }, { type: 'press', key: 'Enter' }, { type: 'wait', text: reply }],
      evidence: [{ selector: item(orchestrator.title) }, { text: reply }] },
    { caption: `"${worker}" sits under its own worktree ${worktree}, not under the orchestrator in main.`, viewport: 'desktop', theme: 'light',
      actions: [{ type: 'wait', selector: `${worktreeRow}[aria-expanded="false"]` }, { type: 'click', selector: worktreeRow }, { type: 'wait', selector: placed }],
      evidence: [{ selector: `${worktreeRow}[aria-expanded="true"]` }, { selector: placed }] },
    { caption: 'The same tree in dark theme.', viewport: 'desktop', theme: 'dark', actions: [],
      evidence: [{ selector: `html.dark ${placed}` }] },
    { caption: 'The hosted mobile drawer places the worker under its worktree too.', viewport: 'mobile', theme: 'dark',
      actions: [{ type: 'navigate', path: 'mobile.html' }, { type: 'wait', selector: 'button[aria-label="Open sessions and projects"]' },
        { type: 'click', selector: 'button[aria-label="Open sessions and projects"]' }, { type: 'wait', selector: `[data-mobile-sessions-drawer] ${item(worker)}` }],
      evidence: [{ selector: `[data-mobile-sessions-drawer] ${placed}` }] },
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

/** Issue #155: the faux model calls html_render; the page shows inline, maximized with zoom, after a reload and on mobile. */
export function htmlRenderTour(manifest) {
  const session = manifest?.sessions?.find(candidate => candidate.role === 'html-render');
  const project = manifest?.projects?.find(candidate => candidate.name === session?.project);
  if (!session || !nonempty(session.title) || !project) throw new Error('Invalid lab seed manifest');
  const label = project.name.replace(/[-_]/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
  const item = `[role="treeitem"][aria-label="${session.title}"]`;
  const composer = '[data-chat-input="true"] .cm-content';
  const sandbox = 'iframe[sandbox="allow-scripts allow-forms"]';
  const frame = `[data-html-render-id] ${sandbox}`;
  const reply = { text: LAB_HTML_RENDER_REPLY };
  // The page loads inside the frame after its URL is minted; give it time to paint before the screenshot.
  const settle = [{ type: 'wait', selector: frame }, { type: 'scroll', selector: '[data-html-render-id]' }, { type: 'wait', ms: 1500 }];
  return validateTour({ name: 'html-render', steps: [
    { caption: `"${session.title}" runs on the lab model. RENDER makes it call html_render, and the page "${LAB_HTML_RENDER_TITLE}" shows inline in the answer, in the app theme.`,
      viewport: 'desktop', theme: 'light',
      actions: [{ type: 'navigate', path: '' }, { type: 'wait', text: label }, { type: 'click', text: label }, { type: 'wait', selector: item },
        // Wait for the seeded answer: the first daemon request of a fresh lab may still be starting the session.
        { type: 'click', selector: item }, { type: 'wait', text: LAB_HTML_RENDER_PROMPT }, { type: 'wait', selector: composer }, { type: 'wait', ms: 2000 },
        { type: 'type', selector: composer, value: 'RENDER' },
        { type: 'press', key: 'Enter' }, { type: 'wait', text: reply.text }, ...settle],
      evidence: [{ selector: frame }, reply] },
    { caption: 'In dark theme the page follows the app colors.', viewport: 'desktop', theme: 'dark', actions: [{ type: 'wait', ms: 1500 }],
      evidence: [{ selector: `html.dark ${frame}` }, reply] },
    { caption: 'Open full screen shows the page in a dialog, in the same sandbox.', viewport: 'desktop', theme: 'light',
      actions: [...settle, { type: 'hover', selector: '[data-html-render-id]' }, { type: 'click', selector: 'button[aria-label="Open full screen"]' },
        { type: 'wait', selector: `[role="dialog"] ${sandbox}` }, { type: 'wait', ms: 1500 }],
      evidence: [{ selector: `[role="dialog"] ${sandbox}` }, { selector: 'button[aria-label="Reset zoom"]', text: '100%' }] },
    // At 125 % the page is larger than its scroll area, so the zoom label is the proof.
    { caption: 'Zoom in enlarges the page to 125 %; the dialog scrolls it.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', selector: 'button[aria-label="Zoom in"]' }, { type: 'wait', ms: 1500 }],
      evidence: [{ selector: 'button[aria-label="Reset zoom"]', text: '125%' }] },
    { caption: 'After a reload the page comes back from the stored session.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'navigate', path: '' }, { type: 'wait', selector: item }, { type: 'click', selector: item }, { type: 'wait', text: reply.text }, ...settle],
      evidence: [{ selector: frame }, reply] },
    { caption: 'The hosted mobile layout shows the same page inline.', viewport: 'mobile', theme: 'light',
      actions: [{ type: 'navigate', path: 'mobile.html' }, { type: 'wait', text: reply.text }, ...settle],
      evidence: [{ selector: frame }] },
  ] });
}

/** Issue #160: a session stays in the sidebar while its worktree directory is removed and comes back with the recreated worktree, without a reload. */
export function recreatedWorktreeTour(manifest) {
  // A committed worktree closes without the discard confirmation that a dirty one needs.
  const worktree = manifest?.worktrees?.find(candidate => candidate.git === 'ahead-behind');
  const session = manifest?.sessions?.find(candidate => candidate.role === 'worktree' && candidate.worktree === worktree?.name && candidate.project === worktree?.project);
  const project = manifest?.projects?.find(candidate => candidate.name === worktree?.project);
  if (!worktree || !session || !nonempty(session.title) || !project || !nonempty(project.path)) throw new Error('Invalid lab seed manifest');
  const label = project.name.replace(/[-_]/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
  // The seed adds each worktree as `<project>-worktrees/<name>` on a branch of the same name.
  const path = `${project.path}-worktrees/${worktree.name}`;
  const row = `[data-tree-node="w:${path}"]`;
  const item = `[role="treeitem"][aria-label="${session.title}"]`;
  const terminal = '.xterm-screen';
  return validateTour({ name: 'recreated-worktree', steps: [
    { caption: `${label} expanded: the worktree ${worktree.name} holds the session "${session.title}".`, viewport: 'desktop', theme: 'light',
      actions: [{ type: 'navigate', path: '' }, { type: 'wait', text: label }, { type: 'click', text: label }, { type: 'wait', selector: row },
        { type: 'click', selector: row }, { type: 'wait', selector: item }],
      evidence: [{ selector: row }, { selector: item }] },
    { caption: `Close worktree removes the ${worktree.name} directory. Its session is hidden while the directory is gone.`, viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', selector: row, button: 'right' }, { type: 'wait', text: 'Close worktree' }, { type: 'click', text: 'Close worktree' },
        { type: 'wait', text: 'unpushed commits' }, { type: 'click', text: 'Close worktree' }, { type: 'wait', text: 'Worktree closed.' }],
      evidence: [{ text: 'Worktree closed.' }, { selector: `[data-tree-node="w:${project.path}"]` }] },
    { caption: `In the terminal, git worktree add recreates ${worktree.name} at the same path.`, viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', selector: 'nav[aria-label="Panel surfaces"] [aria-label="Terminal"]' }, { type: 'wait', selector: terminal }, { type: 'wait', ms: 2000 },
        { type: 'type', selector: terminal, value: `git -C ${project.path} worktree add ${path} ${worktree.name}` }, { type: 'press', key: 'Enter' },
        { type: 'wait', text: 'Preparing worktree' }],
      evidence: [{ selector: terminal }, { text: 'Preparing worktree' }] },
    // Background discovery runs every 60 s and skips results younger than 30 s, so the worktree is back within 90 s.
    { caption: `Without a reload, the next background worktree discovery brings ${worktree.name} back, and with it "${session.title}".`, viewport: 'desktop', theme: 'light',
      actions: [{ type: 'wait', ms: 30000 }, { type: 'wait', ms: 30000 }, { type: 'wait', ms: 30000 }, { type: 'wait', selector: row }, { type: 'wait', selector: item }],
      evidence: [{ selector: row }, { selector: item }] },
  ] });
}

/**
 * Issues #66 and #67 on the lab's terminal-started `serve --foreground` server: Reload Pi clicked twice 80 ms
 * apart shows one result toast; Restart replaces the server process (execve) and the UI comes back by itself.
 */
export function runtimeControlsTour() {
  const reload = 'button[aria-label="Reload Pi"]';
  const restart = 'button[aria-label="Restart PiChamber"]';
  return validateTour({ name: 'runtime-controls', steps: [
    { caption: 'Settings with Reload Pi and Restart PiChamber next to the search (#39).', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'navigate', path: '?settings=general' }, { type: 'wait', selector: reload }], evidence: [{ selector: reload }, { selector: restart }] },
    // A lab reload answers in 50 to 70 ms, so the second click follows at once to land while the first is in flight.
    { caption: 'Reload Pi clicked twice while the first reload runs: one result toast (#67).', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', selector: reload }, { type: 'click', selector: reload }, { type: 'wait', selector: '[data-sonner-toast]' }, { type: 'wait', ms: 1500 }],
      evidence: [{ selector: '[data-sonner-toaster] [data-sonner-toast]:only-child' }] },
    { caption: 'Restart asks once; nothing is working, so it only confirms.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'wait', ms: 5000 }, { type: 'click', selector: restart }, { type: 'wait', text: 'Restart PiChamber?' }],
      evidence: [{ text: 'Restart PiChamber?' }, { text: 'PiChamber restarts its server and the Pi session daemon. Connected devices reconnect on their own.' }] },
    { caption: 'Confirm clicked twice, 80 ms apart: one toast, no failure; the UI waited for the restarted server by itself (#66, #67).', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', text: 'Restart PiChamber' }, { type: 'wait', ms: 80 }, { type: 'click', text: 'Restart PiChamber' }, { type: 'wait', text: 'PiChamber restarted.' }],
      evidence: [{ text: 'PiChamber restarted.' }, { selector: '[data-sonner-toaster] [data-sonner-toast]:only-child' }] },
    { caption: 'After the restart, About shows UI, server and session daemon on one build.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', text: 'About' }, { type: 'wait', text: 'Session daemon' }], evidence: [{ text: 'Session daemon' }, { text: 'Server' }] },
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
