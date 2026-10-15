import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'bun:test';

import { useComposerTargetRowFits } from './useComposerTargetRowFits';

// Real hook; only the browser surface is a stub (same minimal DOM as
// usePendingComposerText.test.tsx): the screen container, the visual viewport
// and the resize observer, each recording its listeners so cleanup is visible.
const installBrowser = () => {
    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    const setGlobal = (name: string, value: unknown) => {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    };
    class ElementStub {}
    const documentStub: Record<string, unknown> = {
        nodeType: 9,
        defaultView: globalThis,
        activeElement: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    };
    const body = {
        nodeType: 1,
        tagName: 'DIV',
        nodeName: 'DIV',
        namespaceURI: 'http://www.w3.org/1999/xhtml',
        ownerDocument: documentStub,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    };
    documentStub.documentElement = body;
    documentStub.body = body;

    const viewport = {
        height: 844,
        listeners: new Set<() => void>(),
        addEventListener(_type: string, listener: () => void) {
            this.listeners.add(listener);
        },
        removeEventListener(_type: string, listener: () => void) {
            this.listeners.delete(listener);
        },
        resizeTo(height: number) {
            this.height = height;
            for (const listener of [...this.listeners]) listener();
        },
    };
    const observers = new Set<{ callback: () => void; disconnected: boolean }>();
    class ResizeObserverStub {
        record: { callback: () => void; disconnected: boolean };
        constructor(callback: () => void) {
            this.record = { callback, disconnected: false };
            observers.add(this.record);
        }
        observe() {}
        disconnect() {
            this.record.disconnected = true;
        }
    }
    const bound = { clientHeight: 788, top: 56 };
    const boundElement = {
        get clientHeight() {
            return bound.clientHeight;
        },
        getBoundingClientRect: () => ({ top: bound.top, height: bound.clientHeight }),
    };
    setGlobal('document', documentStub);
    setGlobal('window', globalThis);
    setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
    setGlobal('Element', ElementStub);
    setGlobal('HTMLElement', ElementStub);
    setGlobal('HTMLIFrameElement', ElementStub);
    setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setGlobal('visualViewport', viewport);
    setGlobal('ResizeObserver', ResizeObserverStub);
    return {
        viewport,
        bound,
        boundElement,
        observers,
        restore: () => {
            for (const [name, descriptor] of descriptors) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        },
    };
};

const roots: Root[] = [];
const restores: Array<() => void> = [];

afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    for (const restore of restores.splice(0)) restore();
});

async function mount(enabled: boolean) {
    const browser = installBrowser();
    restores.push(browser.restore);
    const root = createRoot((globalThis as unknown as { document: { body: Element } }).document.body);
    roots.push(root);
    const form = { current: { closest: () => browser.boundElement } as unknown as HTMLElement };
    const result = { fits: true, renders: 0 };
    function Probe({ on }: { on: boolean }) {
        result.fits = useComposerTargetRowFits(form, on);
        result.renders += 1;
        return null;
    }
    await act(async () => root.render(React.createElement(Probe, { on: enabled })));
    const setEnabled = (on: boolean) => act(async () => root.render(React.createElement(Probe, { on })));
    const unmount = async () => {
        await act(async () => root.unmount());
        roots.splice(roots.indexOf(root), 1);
    };
    return { ...browser, result, setEnabled, unmount };
}

describe('useComposerTargetRowFits', () => {
    test('a tall viewport keeps the row; shrinking to 200px drops it and growing back returns it', async () => {
        const { viewport, bound, result } = await mount(true);
        expect(result.fits).toBe(true);

        bound.clientHeight = 144;
        await act(async () => viewport.resizeTo(200));
        expect(result.fits).toBe(false);

        bound.clientHeight = 788;
        await act(async () => viewport.resizeTo(844));
        expect(result.fits).toBe(true);
    });

    test('the boundary follows the viewport: 241px drops the row, 242px keeps it', async () => {
        const { viewport, bound, result } = await mount(true);

        bound.clientHeight = 241 - 56;
        await act(async () => viewport.resizeTo(241));
        expect(result.fits).toBe(false);

        bound.clientHeight = 242 - 56;
        await act(async () => viewport.resizeTo(242));
        expect(result.fits).toBe(true);
    });

    test('a container resize alone (Capacitor shrinks the element for the keyboard) re-measures', async () => {
        const { observers, bound, result } = await mount(true);
        const [observer] = [...observers];

        bound.clientHeight = 100;
        await act(async () => observer.callback());
        expect(result.fits).toBe(false);

        bound.clientHeight = 400;
        await act(async () => observer.callback());
        expect(result.fits).toBe(true);
    });

    test('repeated identical resize events do not re-render', async () => {
        const { viewport, bound, result } = await mount(true);
        bound.clientHeight = 144;
        await act(async () => viewport.resizeTo(200));
        const rendersAfterChange = result.renders;

        await act(async () => {
            for (let i = 0; i < 30; i += 1) viewport.resizeTo(200);
        });
        expect(result.renders).toBe(rendersAfterChange);
    });

    test('disabled (desktop, tablet, new session draft) always fits and listens to nothing', async () => {
        const { viewport, bound, observers, result } = await mount(false);
        bound.clientHeight = 144;
        await act(async () => viewport.resizeTo(200));
        expect(result.fits).toBe(true);
        expect(viewport.listeners.size).toBe(0);
        expect(observers.size).toBe(0);
    });

    test('disabling and unmounting remove the listener and disconnect the observer', async () => {
        const { viewport, bound, observers, result, setEnabled, unmount } = await mount(true);
        expect(viewport.listeners.size).toBe(1);

        bound.clientHeight = 144;
        await act(async () => viewport.resizeTo(200));
        expect(result.fits).toBe(false);

        await setEnabled(false);
        expect(result.fits).toBe(true);
        expect(viewport.listeners.size).toBe(0);
        expect([...observers].every((observer) => observer.disconnected)).toBe(true);

        await setEnabled(true);
        expect(viewport.listeners.size).toBe(1);
        await unmount();
        expect(viewport.listeners.size).toBe(0);
        expect([...observers].every((observer) => observer.disconnected)).toBe(true);
    });
});
