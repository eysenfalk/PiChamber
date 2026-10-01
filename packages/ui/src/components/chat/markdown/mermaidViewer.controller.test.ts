import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createMermaidViewerRegistry, MERMAID_BLOCK_SELECTOR } from './mermaidViewer';

// Minimal DOM stand-ins: the UI test runner has no DOM, and the controller only
// needs attributes, listeners, selectors and a viewport rect.
class FakeElement {
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(event: FakePointerEvent) => void>>();
  readonly selectors = new Map<string, FakeElement>();

  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, String(value)); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  closest(): null { return null; }
  contains(): boolean { return true; }
  querySelector(selector: string): FakeElement | null { return this.selectors.get(selector) ?? null; }
  querySelectorAll(selector: string): FakeElement[] {
    const match = this.selectors.get(selector);
    return match ? [match] : [];
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 300 }; }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  addEventListener(type: string, listener: (event: FakePointerEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: FakePointerEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string, event: FakePointerEvent): FakePointerEvent {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
}

type FakePointerEvent = {
  pointerId: number;
  pointerType: string;
  button: number;
  clientX: number;
  clientY: number;
  target: FakeElement;
  defaultPrevented: boolean;
  preventDefault: () => void;
};

const near = (value: number): number => Number(value.toFixed(3));

const globals = globalThis as unknown as Record<string, unknown>;
let savedElement: unknown;
let savedWindow: unknown;

beforeEach(() => {
  savedElement = globals.Element;
  savedWindow = globals.window;
  globals.Element = FakeElement;
  globals.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
});

afterEach(() => {
  globals.Element = savedElement;
  globals.window = savedWindow;
});

const setup = (touchGestures?: boolean) => {
  const container = new FakeElement();
  const block = new FakeElement();
  const viewport = new FakeElement();
  const svgHost = new FakeElement();
  const svg = new FakeElement();
  svg.setAttribute('viewBox', '0 0 300 300');
  container.selectors.set(MERMAID_BLOCK_SELECTOR, block);
  block.selectors.set('[data-markdown="mermaid-viewport"]', viewport);
  block.selectors.set('[data-markdown="mermaid"]', svgHost);
  block.selectors.set('[data-markdown="mermaid"] svg', svg);
  const registry = touchGestures === undefined
    ? createMermaidViewerRegistry(container as unknown as HTMLElement)
    : createMermaidViewerRegistry(container as unknown as HTMLElement, { touchGestures });

  const pointer = (type: string, init: Partial<FakePointerEvent>): FakePointerEvent => viewport.dispatch(type, {
    pointerId: 1,
    pointerType: 'touch',
    button: 0,
    clientX: 0,
    clientY: 0,
    target: viewport,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    ...init,
  });
  const viewBox = () => svg.getAttribute('viewBox')?.split(' ').map(Number) ?? [];
  return { registry, block, pointer, viewBox };
};

describe('mermaid viewer pointer gestures', () => {
  test('inline viewers leave touch to the page and still pan with a mouse', () => {
    const { registry, block, pointer, viewBox } = setup();
    expect(block.hasAttribute('data-mermaid-touch-gestures')).toBe(false);

    const touchDown = pointer('pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });
    pointer('pointermove', { pointerId: 1, clientX: 140, clientY: 160 });
    expect(touchDown.defaultPrevented).toBe(false);
    expect(block.hasAttribute('data-mermaid-panning')).toBe(false);
    expect(viewBox()).toEqual([0, 0, 300, 300]);
    pointer('pointerup', { pointerId: 1 });

    pointer('pointerdown', { pointerId: 2, pointerType: 'mouse', clientX: 100, clientY: 100 });
    pointer('pointermove', { pointerId: 2, pointerType: 'mouse', clientX: 110, clientY: 120 });
    pointer('pointerup', { pointerId: 2, pointerType: 'mouse' });
    expect(viewBox()).toEqual([-10, -20, 300, 300]);
    registry.cleanup();
  });

  test('gesture viewers pinch-zoom with two fingers and keep panning with the remaining one', () => {
    const { registry, block, pointer, viewBox } = setup(true);
    expect(block.getAttribute('data-mermaid-touch-gestures')).toBe('true');

    const firstDown = pointer('pointerdown', { pointerId: 1, clientX: 100, clientY: 150 });
    pointer('pointerdown', { pointerId: 2, clientX: 200, clientY: 150 });
    expect(firstDown.defaultPrevented).toBe(true);
    expect(block.hasAttribute('data-mermaid-suppress-click')).toBe(true);

    pointer('pointermove', { pointerId: 1, clientX: 50, clientY: 150 });
    pointer('pointermove', { pointerId: 2, clientX: 250, clientY: 150 });
    const [, , zoomedWidth, zoomedHeight] = viewBox();
    expect(near(zoomedWidth)).toBe(150);
    expect(near(zoomedHeight)).toBe(150);

    pointer('pointerup', { pointerId: 1 });
    expect(block.hasAttribute('data-mermaid-panning')).toBe(true);
    const [beforeX, beforeY] = viewBox();
    pointer('pointermove', { pointerId: 2, clientX: 270, clientY: 150 });
    const [afterX, afterY, afterWidth] = viewBox();
    // 20px finger move at 2x zoom pans 10 SVG units, with no jump from the lifted finger.
    expect(near(afterX)).toBe(near(beforeX - 10));
    expect(near(afterY)).toBe(near(beforeY));
    expect(near(afterWidth)).toBe(150);

    pointer('pointerup', { pointerId: 2 });
    expect(block.hasAttribute('data-mermaid-panning')).toBe(false);
    registry.cleanup();
    expect(block.hasAttribute('data-mermaid-touch-gestures')).toBe(false);
  });

  test('a third finger is ignored while pinching', () => {
    const { registry, pointer, viewBox } = setup(true);
    pointer('pointerdown', { pointerId: 1, clientX: 100, clientY: 150 });
    pointer('pointerdown', { pointerId: 2, clientX: 200, clientY: 150 });
    const third = pointer('pointerdown', { pointerId: 3, clientX: 10, clientY: 10 });
    pointer('pointermove', { pointerId: 3, clientX: 290, clientY: 290 });
    expect(third.defaultPrevented).toBe(false);
    expect(viewBox()).toEqual([0, 0, 300, 300]);
    registry.cleanup();
  });
});
