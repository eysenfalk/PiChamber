import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fixture, brokenFixture, labTour, validateTour, VIEWPORTS } from './tours.mjs';
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
      { type: 'wait', ms: 100 }, { type: 'wait', selector: '#ready' }, { type: 'set-theme', theme: 'dark' }, { type: 'set-viewport', viewport: 'mobile' }];
    expect(validateTour(tour)).toBe(tour);
    for (const action of [{ type: 'clic', selector: '#x' }, { type: 'wait', ms: 30001 }, { type: 'wait', ms: -1 },
      { type: 'wait', ms: 1, text: 'x' }, { type: 'click' }, { type: 'type', selector: '#x' },
      { type: 'scroll', selector: '#x', y: Infinity }, { type: 'set-theme', theme: 'system' },
      { type: 'navigate', path: 'https://example.com' }, { type: 'navigate', path: '//example.com' }]) {
      tour.steps[0].actions = [action]; expect(() => validateTour(tour)).toThrow('Invalid tour');
    }
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
});
