import { describe, expect, test } from 'bun:test';
import { fixture, brokenFixture, labTour, validateTour, VIEWPORTS } from './tours.mjs';
const copy = () => structuredClone(fixture);

describe('tours.mjs format', () => {
  test('fixture and intentionally failing tour are valid data; exact desktop/mobile touch presets', () => {
    expect(validateTour(fixture)).toBe(fixture);
    expect(validateTour(brokenFixture)).toBe(brokenFixture);
    expect(VIEWPORTS.desktop).toEqual({ width: 1440, height: 900, mobile: false });
    expect(VIEWPORTS.mobile).toEqual({ width: 390, height: 844, mobile: true });
  });
  test('bad names, empty steps, captions, viewports, themes and evidence are rejected', () => {
    for (const mutate of [tour => tour.name = '../escape', tour => tour.steps = [], tour => tour.steps[0].caption = '',
      tour => tour.steps[0].theme = 'system', tour => tour.steps[0].viewport = 'tablet', tour => tour.steps[0].evidence = [],
      tour => tour.steps[0].evidence = [{ selector: '#x', text: 'x' }], tour => tour.steps[0].evidence = [{ text: 'x', index: 0 }],
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
    const tour = labTour({ projects: [{ name: 'one', path: '/one' }, { name: 'two', path: '/two' }], sessions: [{ project: 'one', title: 'Long named session', role: 'long' }] });
    expect(tour.steps[0].evidence).toEqual([{ text: 'one' }, { text: 'two' }, { text: 'Long named session' }]);
    expect(tour.steps[1].actions[0]).toEqual({ type: 'click', text: 'Long named session' });
    expect(tour.steps.at(-1).viewport).toBe('mobile');
    expect(() => labTour({})).toThrow('Invalid lab seed manifest');
  });
});
