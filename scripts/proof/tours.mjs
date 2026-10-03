export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, mobile: false },
  mobile: { width: 390, height: 844, mobile: true },
};
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
        navigate: ['type', 'path'], click: ['type', 'selector', 'text'], type: ['type', 'selector', 'value'],
        scroll: ['type', 'selector', 'x', 'y'], wait: ['type', 'ms', 'selector', 'text'],
        'set-theme': ['type', 'theme'], 'set-viewport': ['type', 'viewport'],
      };
      if (!Object.hasOwn(schemas, action.type) || !keys(action, schemas[action.type])) fail();
      if (action.type === 'navigate' && (typeof action.path !== 'string' || (/^[a-z]+:/i.test(action.path) || action.path.startsWith('//')))) fail();
      if (action.type === 'click' && !target(action)) fail();
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
  const file = { ...tool, text: 'README.md' };
  return validateTour({ name: 'lab', steps: [
    { caption: 'Prepared projects and sessions in the lab sidebar.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'navigate', path: '' }, { type: 'wait', text: label(projects[0].name) }, { type: 'click', text: long.title }], evidence: sidebar },
    { caption: 'The long session includes an Edit File tool call for README.md.', viewport: 'desktop', theme: 'light',
      actions: [{ type: 'click', text: long.title }, { type: 'wait', selector: 'button[aria-label="Expand activity"]' },
        { type: 'scroll', selector: 'button[aria-label="Expand activity"]' }, { type: 'click', selector: 'button[aria-label="Expand activity"]' },
        { type: 'wait', selector: tool.selector }, { type: 'scroll', selector: tool.selector }], evidence: [tool, file] },
    { caption: 'The same tool call in dark theme.', viewport: 'desktop', theme: 'dark', actions: [],
      evidence: [tool, file].map(item => ({ ...item, selector: 'html.dark [data-chat-activity-row]' })) },
    { caption: 'Projects and sessions in the hosted mobile sidebar.', viewport: 'mobile', theme: 'dark',
      actions: [{ type: 'navigate', path: 'mobile.html' }, { type: 'wait', selector: 'button[aria-label="Open sessions and projects"]' },
        { type: 'click', selector: 'button[aria-label="Open sessions and projects"]' }],
      evidence: [{ selector: '[data-mobile-sessions-drawer] button[aria-pressed="true"]' },
        ...projects.map(project => ({ text: label(project.name) })), { text: short.title }] },
  ] });
}
