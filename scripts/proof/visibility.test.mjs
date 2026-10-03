import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { checkEvidence, evidenceExpression, visibilityReason } from './visibility.mjs';

const rect = { left: 10, top: 10, right: 110, bottom: 60 };
const viewport = { width: 1440, height: 900 };
const snapshot = extra => ({ rects: [rect], viewport, ...extra });
const style = { display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible' };
const element = (extra = {}) => ({ tagName: 'DIV', parentElement: null, clientLeft: 0, clientTop: 0, clientWidth: 100, clientHeight: 50,
  scrollWidth: 100, scrollHeight: 50, getBoundingClientRect: () => rect, querySelectorAll: () => [], style, ...extra });
function documentFixture(elements, texts = []) {
  return { body: {}, querySelectorAll: selector => elements[selector] || [], createRange: () => {
    let node;
    return { selectNodeContents: value => { node = value; }, getClientRects: () => node.rects || [rect] };
  }, createTreeWalker: () => { let index = 0; return { nextNode: () => texts[index++] || null }; } };
}
const check = (evidence, root) => runInNewContext(evidenceExpression(evidence), { document: root, innerWidth: 1440, innerHeight: 900, getComputedStyle: node => node.style });

describe('visibility.mjs geometry', () => {
  test('positive rectangles fully inside the viewport, including exact edges', () => {
    expect(visibilityReason(snapshot())).toBe('');
    expect(visibilityReason(snapshot({ rects: [{ left: 0, top: 0, right: 1440, bottom: 900 }] }))).toBe('');
  });
  test('missing, empty, invalid and offscreen rectangles fail', () => {
    expect(visibilityReason(snapshot({ rects: [] }))).toBe('no rendered rectangle');
    for (const bad of [{ ...rect, right: 10 }, { ...rect, top: NaN }]) expect(visibilityReason(snapshot({ rects: [bad] }))).toBe('empty rectangle');
    for (const bad of [{ ...rect, left: -0.01 }, { ...rect, bottom: 901 }, { ...rect, right: 1441 }]) expect(visibilityReason(snapshot({ rects: [bad] }))).toBe('outside viewport');
  });
  test('nested scrolling ancestors clip by axis and by their inner border', () => {
    const clip = { name: 'aside', x: true, y: false, left: 11, right: 120, top: 11, bottom: 40 };
    expect(visibilityReason(snapshot({ ancestors: [clip] }))).toBe('clipped by aside');
    expect(visibilityReason(snapshot({ ancestors: [{ ...clip, x: false, y: true }] }))).toBe('clipped by aside');
    expect(visibilityReason(snapshot({ ancestors: [{ ...clip, x: false, y: false }] }))).toBe('');
  });
  test('hidden elements and cut off text never pass', () => {
    expect(visibilityReason(snapshot({ hidden: true }))).toBe('hidden');
    expect(visibilityReason(snapshot({ cutOff: 'content cut off in span' }))).toBe('content cut off in span');
  });
});

describe('visibility.mjs serialised page function on DOM fixtures', () => {
  test('missing selectors and invalid CSS fail; every matching element is checked', () => {
    expect(check([{ selector: '#missing' }], documentFixture({})).ok).toBe(false);
    const hidden = element({ style: { ...style, opacity: '0' } });
    const root = documentFixture({ '.rows': [element(), hidden] });
    expect(check([{ selector: '.rows' }], root).ok).toBe(false);
    expect(check([{ selector: '.rows', index: 0 }], root).ok).toBe(true);
    expect(check([{ selector: '.rows', index: 8 }], root).ok).toBe(false);
    expect(check([{ selector: '[' }], { querySelectorAll: () => { throw new Error('Invalid selector'); } }).results[0].reason).toBe('Invalid selector');
  });
  test('a clipped descendant and overflowing evidence fail', () => {
    const parent = element({ clientWidth: 90, style: { ...style, overflowX: 'auto' } });
    const child = element({ parentElement: parent });
    expect(check([{ selector: '#x' }], documentFixture({ '#x': [child] })).results[0].reason).toBe('clipped by div');
    const truncated = element({ scrollWidth: 120, style: { ...style, overflowX: 'hidden' } });
    expect(check([{ selector: '#x' }], documentFixture({ '#x': [truncated] })).results[0].reason).toBe('content cut off in div');
  });
  test('text must be rendered, fully visible, normalized and not script contents', () => {
    const text = { textContent: 'Prepared   session', parentElement: element() };
    expect(check([{ text: 'Prepared session' }], documentFixture({}, [text])).ok).toBe(true);
    expect(check([{ text: 'Other session' }], documentFixture({}, [text])).ok).toBe(false);
    const offscreen = { ...text, rects: [{ ...rect, bottom: 901 }] };
    expect(check([{ text: 'Prepared session' }], documentFixture({}, [offscreen])).ok).toBe(false);
    const hidden = { ...text, parentElement: element({ style: { ...style, visibility: 'hidden' } }) };
    expect(check([{ text: 'Prepared session' }], documentFixture({}, [hidden])).ok).toBe(false);
    const script = { ...text, parentElement: element({ tagName: 'SCRIPT' }) };
    expect(check([{ text: 'Prepared session' }], documentFixture({}, [script])).ok).toBe(false);
    expect(check([{ text: 'Prepared session' }], documentFixture({}, [hidden, text])).ok).toBe(true);
  });
  test('the page function is explicitly serializable, with no browser dependency at import', () => {
    expect(typeof checkEvidence).toBe('function');
    expect(evidenceExpression([{ text: 'a "quote"' }])).toContain(JSON.stringify([{ text: 'a "quote"' }]));
  });
});

test('visibility.mjs scoped text must occur visibly inside the selected tool row, not elsewhere', () => {
  const tool = element();
  const reasoning = element();
  const text = { textContent: 'Edit File', parentElement: tool };
  const root = documentFixture({ '.rows': [reasoning, tool] });
  root.createTreeWalker = scope => { let done = false; return { nextNode: () => {
    if (done || scope !== tool) return null; done = true; return text;
  } }; };
  expect(check([{ selector: '.rows', index: 0, text: 'Edit File' }], root).ok).toBe(false);
  expect(check([{ selector: '.rows', index: 1, text: 'Edit File' }], root).ok).toBe(true);
  text.rects = [{ ...rect, bottom: 901 }];
  expect(check([{ selector: '.rows', index: 1, text: 'Edit File' }], root).ok).toBe(false);
});
