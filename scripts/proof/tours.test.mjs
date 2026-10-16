import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { addDeviceTour, controlCenterTour, extensionMessagesTour, fixture, brokenFixture, forkRenameTour, htmlRenderTour, labTour, orchestrationTour, recreatedWorktreeTour, settledQuestionsTour, toolProfilesTour, validateTour, VIEWPORTS, worktreeWorkerTour } from './tours.mjs';
import { EVENTS_MESSAGE } from '../../packages/web/server/lib/pi/session-daemon/orchestration/wakes.js';
import { LAB_ASKER_BLOCKER, LAB_ASKER_QUESTION, LAB_ASKER_TITLE, LAB_ASKER_TWO_TITLE, LAB_CHOOSER_DIALOGS, LAB_RESOLVED_REPLY, LAB_STOPPED_REPLY, LAB_CHOOSER_TITLE, LAB_WORKER_TITLE, LAB_WORKTREE_WORKER } from '../lab/faux-orchestration.mjs';
const copy = () => structuredClone(fixture);

describe('tours.mjs format', () => {
  test('automation CLIs reject unknown flags with one usage line on stderr, and no stdout', () => {
    for (const script of ['record.mjs', 'publish.mjs']) {
      const result = spawnSync('node', [new URL(script, import.meta.url).pathname, '--quiet'], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim().split('\n')).toHaveLength(1);
      expect(result.stderr).toContain('Usage:');
    }
  });
  test('fixture and intentionally failing tour are valid data; exact desktop/mobile touch presets', () => {
    expect(validateTour(fixture)).toBe(fixture);
    expect(validateTour(brokenFixture)).toBe(brokenFixture);
    expect(VIEWPORTS.desktop).toEqual({ width: 1440, height: 900, mobile: false });
    expect(VIEWPORTS.mobile).toEqual({ width: 390, height: 844, mobile: true });
  });
  test('bad names, empty steps, captions, viewports, themes and evidence are rejected', () => {
    for (const mutate of [tour => tour.name = '../escape', tour => tour.steps = [], tour => tour.steps[0].caption = '',
      tour => tour.steps[0].theme = 'system', tour => tour.steps[0].viewport = 'tablet', tour => tour.steps[0].evidence = [],
      tour => tour.steps[0].evidence = [{ selector: '#x', text: '' }], tour => tour.steps[0].evidence = [{ text: 'x', index: 0 }],
      tour => tour.steps[0].evidence = [{ selector: '#x', index: -1 }], tour => tour.steps[0].evidence = [{ selector: '#x', typo: true }]]) {
      const tour = copy(); mutate(tour); expect(() => validateTour(tour)).toThrow('Invalid tour');
    }
  });
  test('all action types accepted; typos, unbounded waits and cross-origin navigation rejected', () => {
    const tour = copy();
    tour.steps[0].actions = [{ type: 'navigate', path: 'mobile.html' }, { type: 'click', text: 'Session' },
      { type: 'type', selector: '#input', value: '' }, { type: 'scroll', selector: '#scroll', y: 50 },
      { type: 'wait', ms: 100 }, { type: 'wait', selector: '#ready' }, { type: 'set-theme', theme: 'dark' }, { type: 'set-viewport', viewport: 'mobile' },
      { type: 'click', selector: '#row', button: 'right' }, { type: 'press', key: 'ArrowDown' }, { type: 'drag', from: { text: 'Row' }, to: { selector: '#folder' } }];
    expect(validateTour(tour)).toBe(tour);
    for (const action of [{ type: 'clic', selector: '#x' }, { type: 'wait', ms: 30001 }, { type: 'wait', ms: -1 },
      { type: 'wait', ms: 1, text: 'x' }, { type: 'click' }, { type: 'type', selector: '#x' },
      { type: 'scroll', selector: '#x', y: Infinity }, { type: 'set-theme', theme: 'system' },
      { type: 'navigate', path: 'https://example.com' }, { type: 'navigate', path: '//example.com' },
      { type: 'click', text: 'x', button: 'middle' }, { type: 'press', key: 'a' }, { type: 'press' },
      { type: 'drag', from: { text: 'x' } }, { type: 'drag', from: { text: 'x' }, to: { selector: '#y', text: 'y' } },
      { type: 'hover' }, { type: 'hover', selector: '#x', text: 'x' }, { type: 'long-press' }]) {
      tour.steps[0].actions = [action]; expect(() => validateTour(tour)).toThrow('Invalid tour');
    }
  });
  test('hover works on any viewport; long-press only where touch is emulated', () => {
    const tour = copy();
    tour.steps[0].viewport = 'desktop';
    tour.steps[0].actions = [{ type: 'hover', selector: '#row' }];
    expect(validateTour(tour)).toBe(tour);
    tour.steps[0].actions = [{ type: 'long-press', selector: '#row' }];
    expect(() => validateTour(tour)).toThrow('Invalid tour');
    tour.steps[0].viewport = 'mobile';
    expect(validateTour(tour)).toBe(tour);
  });
  test('lab title and project evidence are taken from the seed manifest, never row position', () => {
    const tour = labTour({ projects: [{ name: 'lab-one', path: '/one' }, { name: 'lab_two', path: '/two' }], sessions: [{ project: 'lab-one', title: 'Long named session', role: 'long' }, { project: 'lab_two', title: 'Short session', role: 'short' }] });
    expect(tour.steps[0].evidence).toEqual([{ text: 'Lab One' }, { text: 'Lab Two' }, { text: 'Long named session' }]);
    expect(tour.steps[1].evidence).toContainEqual({ selector: '[data-chat-activity-row]', index: 0, text: 'Edit File' });
    expect(tour.steps[1].caption).toBe('The long session includes an Edit File tool call.');
    expect(tour.steps[2].evidence[0].selector).toBe('html.dark [data-chat-activity-row]');
    expect(tour.steps[1].actions[0]).toEqual({ type: 'click', text: 'Long named session' });
    expect(tour.steps.at(-1).viewport).toBe('mobile');
    expect(tour.steps.at(-1).evidence).toContainEqual({ text: 'Short session' });
    expect(tour.steps.at(-1).evidence).not.toContainEqual({ text: 'Long named session' });
    expect(tour.steps[1].actions).toContainEqual({ type: 'click', selector: 'button[aria-label="Expand activity"]' });
    expect(tour.steps.at(-1).actions[0]).toEqual({ type: 'navigate', path: 'mobile.html' });
    expect(() => labTour({})).toThrow('Invalid lab seed manifest');
  });
  test('fork-rename evidence is the fork title and project from the seed manifest', () => {
    const tour = forkRenameTour({ projects: [{ name: 'lab-one', path: '/one' }], sessions: [{ project: 'lab-one', title: 'Renamed fork', role: 'fork' }] });
    expect(tour.name).toBe('fork-rename');
    expect(tour.steps[0].evidence).toEqual([{ text: 'Lab One' }, { text: 'Renamed fork' }]);
    expect(tour.steps[1].actions[0]).toEqual({ type: 'click', text: 'Renamed fork' });
    expect(tour.steps.at(-1).viewport).toBe('mobile');
    expect(tour.steps.at(-1).evidence).toEqual([{ text: 'Renamed fork' }]);
    expect(() => forkRenameTour({ projects: [], sessions: [{ project: 'lab-one', title: 'Renamed fork', role: 'fork' }] })).toThrow('Invalid lab seed manifest');
    expect(() => forkRenameTour({ projects: [{ name: 'lab-one', path: '/one' }], sessions: [] })).toThrow('Invalid lab seed manifest');
  });
  test('orchestration drives the seeded orchestrator and proves nesting, responsiveness and both wake rows', () => {
    const tour = orchestrationTour({ projects: [{ name: 'lab-one', path: '/one' }], sessions: [{ project: 'lab-one', title: 'Orchestrator', role: 'orchestrator' }] });
    expect(tour.name).toBe('orchestration');
    expect(tour.steps[0].actions[0]).toEqual({ type: 'navigate', path: '?settings=sessions' });
    expect(tour.steps[1].evidence).toContainEqual({ selector: '[aria-label="Review model"]' });
    expect(tour.steps[2].actions).toContainEqual({ type: 'click', selector: '[data-tree-node="w:/one"]' });
    const typed = tour.steps.flatMap(step => step.actions).filter(action => action.type === 'type').map(action => action.value);
    expect(typed).toEqual(['ORCHESTRATE', 'STATUS?', 'GO']);
    const evidence = tour.steps.flatMap(step => step.evidence);
    expect(evidence).toContainEqual({ selector: `[role="treeitem"][aria-label="${LAB_WORKER_TITLE}"]` });
    // The rows are the daemon's wake messages, not the legacy result card.
    expect(evidence).toContainEqual({ selector: `[data-extension-type="${EVENTS_MESSAGE}"]`, index: 1 });
    expect(tour.steps.map(step => `${step.viewport}/${step.theme}`)).toContain('mobile/dark');
    expect(() => orchestrationTour({ projects: [{ name: 'lab-one', path: '/one' }], sessions: [] })).toThrow('Invalid lab seed manifest');
  });
  test('tool-profiles sends REVIEW to the orchestrator and proves the blocked review worker', () => {
    const tour = toolProfilesTour({ projects: [{ name: 'lab-one', path: '/one' }], sessions: [{ project: 'lab-one', title: 'Orchestrator', role: 'orchestrator' }] });
    expect(tour.name).toBe('tool-profiles');
    const typed = tour.steps.flatMap(step => step.actions).filter(action => action.type === 'type').map(action => action.value);
    expect(typed).toEqual(['REVIEW']);
    const evidence = tour.steps.flatMap(step => step.evidence);
    expect(evidence).toContainEqual({ text: 'could not change README.md' });
    expect(evidence).toContainEqual({ text: 'git: README.md unchanged' });
    expect(evidence).toContainEqual({ text: 'Tools sent to me (review worker, profile read-only)' });
    expect(() => toolProfilesTour({ projects: [{ name: 'lab-one', path: '/one' }], sessions: [] })).toThrow('Invalid lab seed manifest');
  });

  test('control-center answers a dialog in the chat and one from the inbox, the question with an option and the blocker with free text, in both themes and on mobile', () => {
    const tour = controlCenterTour({ projects: [{ name: 'lab-one', path: '/one' }], sessions: [{ project: 'lab-one', title: 'Orchestrator', role: 'orchestrator' }] });
    expect(tour.name).toBe('control-center');
    const actions = tour.steps.flatMap(step => step.actions);
    expect(actions.filter(action => action.type === 'type').map(action => action.value)).toEqual(['ASK', 'CHOOSE', 'ANSWER: keep the copy']);
    expect(actions).toContainEqual({ type: 'click', selector: '[aria-label="Decision inbox"] [data-inbox-option="Fail the check"]' });
    expect(actions).toContainEqual({ type: 'click', text: 'Send answer' });
    // The first dialog is answered in the chat, the second in the inbox.
    expect(actions).toContainEqual({ type: 'wait', selector: `[role="dialog"][aria-label="${LAB_CHOOSER_DIALOGS[0].title}"]` });
    expect(actions).toContainEqual({ type: 'click', text: LAB_CHOOSER_DIALOGS[0].options[1] });
    expect(actions).toContainEqual({ type: 'click', text: LAB_CHOOSER_DIALOGS[1].options[0] });
    const evidence = tour.steps.flatMap(step => step.evidence);
    expect(evidence).toContainEqual({ selector: '[aria-label="Decision inbox"] [data-inbox-question]', text: LAB_ASKER_QUESTION });
    expect(evidence).toContainEqual({ selector: '[aria-label="Decision inbox"] [data-inbox-question]', text: LAB_ASKER_BLOCKER });
    expect(evidence).toContainEqual({ text: 'Until then:' });
    expect(evidence).toContainEqual({ selector: `button[aria-label="Open ${LAB_ASKER_TITLE}"]` });
    expect(evidence).toContainEqual({ selector: '[aria-label="Decision inbox"] [data-inbox-dialog]', text: LAB_CHOOSER_DIALOGS[1].title });
    expect(evidence).toContainEqual({ selector: `button[aria-label="Open ${LAB_CHOOSER_TITLE}"]` });
    expect(new Set(tour.steps.map(step => `${step.viewport}/${step.theme}`))).toEqual(new Set(['desktop/light', 'desktop/dark', 'mobile/light', 'mobile/dark']));
    expect(() => controlCenterTour({ projects: [{ name: 'lab-one', path: '/one' }], sessions: [] })).toThrow('Invalid lab seed manifest');
  });

  test('settled-questions closes an owner question answered in the chat and the question of a stopped worker (#231)', () => {
    const tour = settledQuestionsTour({ projects: [{ name: 'lab-one', path: '/one' }], sessions: [{ project: 'lab-one', title: 'Orchestrator', role: 'orchestrator' }] });
    expect(tour.name).toBe('settled-questions');
    const actions = tour.steps.flatMap(step => step.actions);
    expect(actions.filter(action => action.type === 'type').map(action => action.value)).toEqual(['ASK', 'OWNER: Fail the check', 'ASK TWO', 'STOP ASKER']);
    const evidence = tour.steps.flatMap(step => step.evidence);
    expect(evidence).toContainEqual({ selector: '[aria-label="Decision inbox"] [data-inbox-question]', text: LAB_ASKER_QUESTION });
    expect(evidence).toContainEqual({ selector: `button[aria-label="Open ${LAB_ASKER_TITLE}"]` });
    expect(evidence).toContainEqual({ selector: `button[aria-label="Open ${LAB_ASKER_TWO_TITLE}"]` });
    expect(evidence).toContainEqual({ text: LAB_RESOLVED_REPLY });
    expect(evidence).toContainEqual({ text: LAB_STOPPED_REPLY });
    // Each close ends in an empty inbox with no waiting decision.
    expect(evidence.filter(entry => entry.text === 'No open questions or dialogs.')).toHaveLength(2);
    expect(() => settledQuestionsTour({ projects: [{ name: 'lab-one', path: '/one' }], sessions: [] })).toThrow('Invalid lab seed manifest');
  });

  test('worktree-worker spawns a worker in a linked worktree and proves it sits under that worktree', () => {
    const tour = worktreeWorkerTour({ projects: [{ name: 'lab-one', path: '/one' }], sessions: [{ project: 'lab-one', title: 'Orchestrator', role: 'orchestrator' }] });
    expect(tour.name).toBe('worktree-worker');
    const actions = tour.steps.flatMap(step => step.actions);
    expect(actions.filter(action => action.type === 'type').map(action => action.value)).toEqual(['ORCHESTRATE WORKTREE']);
    expect(actions).toContainEqual({ type: 'click', selector: `[data-tree-node="w:/one-worktrees/${LAB_WORKTREE_WORKER.worktree}"]` });
    const evidence = tour.steps.flatMap(step => step.evidence);
    expect(evidence).toContainEqual({ selector: `[role="treeitem"][aria-label="${LAB_WORKTREE_WORKER.title}"][aria-level="3"]` });
    expect(tour.steps.map(step => `${step.viewport}/${step.theme}`)).toEqual(['desktop/light', 'desktop/light', 'desktop/dark', 'mobile/dark']);
    expect(() => worktreeWorkerTour({ projects: [{ name: 'lab-one', path: '/one' }], sessions: [] })).toThrow('Invalid lab seed manifest');
  });

  test('extension-messages opens the seeded session and proves the grouped rows and their Markdown', () => {
    const tour = extensionMessagesTour({ projects: [{ name: 'lab-one', path: '/one' }], sessions: [{ project: 'lab-one', title: 'Extensions', role: 'extensions' }] });
    expect(tour.name).toBe('extension-messages');
    expect(tour.steps[0].actions).toContainEqual({ type: 'click', selector: '[role="treeitem"][aria-label="Extensions"]' });
    // The first two steps prove only the seeded turns, so a build before #147 records the same view.
    expect(tour.steps.slice(0, 2).flatMap(step => step.evidence).every(item => item.text && !item.selector)).toBe(true);
    const evidence = tour.steps.flatMap(step => step.evidence);
    expect(evidence).toContainEqual({ text: '9 Intercom messages' });
    expect(evidence.some(item => item.selector?.startsWith('.chat-message-column '))).toBe(true);
    expect(tour.steps.map(step => `${step.viewport}/${step.theme}`)).toEqual(['desktop/light', 'mobile/light', 'desktop/light', 'desktop/light', 'desktop/dark', 'mobile/dark']);
    expect(() => extensionMessagesTour({ projects: [{ name: 'lab-one', path: '/one' }], sessions: [] })).toThrow('Invalid lab seed manifest');
  });
  test('html-render sends RENDER in the seeded session and proves the sandboxed frame, the zoom dialog, a reload and mobile', () => {
    const tour = htmlRenderTour({ projects: [{ name: 'lab-one', path: '/one' }], sessions: [{ project: 'lab-one', title: 'Render', role: 'html-render' }] });
    expect(tour.name).toBe('html-render');
    expect(tour.steps[0].actions).toContainEqual({ type: 'type', selector: '[data-chat-input="true"] .cm-content', value: 'RENDER' });
    const evidence = tour.steps.flatMap(step => step.evidence);
    // Never allow-same-origin: the evidence pins the exact sandbox of the inline and the maximized frame.
    expect(evidence).toContainEqual({ selector: '[data-html-render-id] iframe[sandbox="allow-scripts allow-forms"]' });
    expect(evidence).toContainEqual({ selector: '[role="dialog"] iframe[sandbox="allow-scripts allow-forms"]' });
    expect(evidence).toContainEqual({ selector: 'button[aria-label="Reset zoom"]', text: '125%' });
    expect(tour.steps.map(step => `${step.viewport}/${step.theme}`)).toEqual(['desktop/light', 'desktop/dark', 'desktop/light', 'desktop/light', 'desktop/light', 'mobile/light']);
    expect(() => htmlRenderTour({ projects: [{ name: 'lab-one', path: '/one' }], sessions: [] })).toThrow('Invalid lab seed manifest');
  });
  test('recreated-worktree closes a committed worktree, recreates it in the terminal and waits for its session without a reload', () => {
    const manifest = { projects: [{ name: 'lab-one', path: '/one' }], worktrees: [{ project: 'lab-one', name: 'dirty-one', git: 'dirty' }, { project: 'lab-one', name: 'clean-one', git: 'ahead-behind' }],
      sessions: [{ project: 'lab-one', worktree: 'dirty-one', title: 'Dirty', role: 'worktree' }, { project: 'lab-one', worktree: 'clean-one', title: 'Clean', role: 'worktree' }] };
    const tour = recreatedWorktreeTour(manifest);
    expect(tour.name).toBe('recreated-worktree');
    const actions = tour.steps.flatMap(step => step.actions);
    expect(actions.filter(action => action.type === 'navigate')).toHaveLength(1);
    expect(actions).toContainEqual({ type: 'type', selector: '.xterm-screen', value: 'git -C /one worktree add /one-worktrees/clean-one clean-one' });
    expect(tour.steps.at(-1).evidence).toEqual([{ selector: '[data-tree-node="w:/one-worktrees/clean-one"]' }, { selector: '[role="treeitem"][aria-label="Clean"]' }]);
    expect(() => recreatedWorktreeTour({ ...manifest, worktrees: [] })).toThrow('Invalid lab seed manifest');
  });
  test('add-device requires Home network selected and Tailscale disabled in every viewport and theme', () => {
    const tour = addDeviceTour();
    expect(tour.steps.map(step => `${step.viewport}/${step.theme}`)).toEqual(['desktop/light', 'desktop/dark', 'mobile/light', 'mobile/dark']);
    for (const step of tour.steps) {
      expect(step.actions[0]).toEqual({ type: 'navigate', path: step.viewport === 'desktop' ? '?settings=remote-instances' : 'mobile.html' });
      expect(step.actions.at(-2)).toEqual({ type: 'click', text: 'Add a device' });
      expect(step.evidence).toContainEqual({ selector: '[role="radio"][aria-label="Tailscale (recommended)"][aria-checked="false"]:disabled' });
      expect(step.evidence[0].selector.startsWith(step.theme === 'dark' ? 'html.dark ' : '[role="radio"]')).toBe(true);
    }
  });
});
