import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'bun:test';

import { useInputStore } from '@/sync/input-store';

import { usePendingComposerText } from './usePendingComposerText';

// Real hook against the real input store; only the DOM is a stub (same
// minimal harness as useChatAutoFollow.test.ts).
const installMinimalDom = (): (() => void) => {
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
    const container = {
        nodeType: 1,
        tagName: 'DIV',
        nodeName: 'DIV',
        namespaceURI: 'http://www.w3.org/1999/xhtml',
        ownerDocument: documentStub,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    };
    documentStub.documentElement = container;
    documentStub.body = container;
    setGlobal('document', documentStub);
    setGlobal('window', globalThis);
    setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
    setGlobal('Element', ElementStub);
    setGlobal('HTMLElement', ElementStub);
    setGlobal('HTMLIFrameElement', ElementStub);
    setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    return () => {
        for (const [name, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    };
};

const roots: Root[] = [];
const restores: Array<() => void> = [];

afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    for (const restore of restores.splice(0)) restore();
    act(() => {
        useInputStore.getState().setPendingInputText(null);
        useInputStore.getState().setPendingRevertText(null);
    });
});

/** Mounts a composer stand-in: a draft plus a "minimized" flag the hook may clear. */
async function mount(initialDraft: string) {
    restores.push(installMinimalDom());
    const container = (globalThis as unknown as { document: { body: Element } }).document.body;
    const root = createRoot(container);
    roots.push(root);
    const state = { message: initialDraft, minimized: true };
    const applied = { count: 0 };
    function Probe() {
        const [message, setMessage] = React.useState(initialDraft);
        const [minimized, setMinimized] = React.useState(true);
        state.message = message;
        state.minimized = minimized;
        const onApplied = React.useCallback(() => {
            applied.count += 1;
            setMinimized(false);
        }, []);
        usePendingComposerText({ message, setMessage, onApplied });
        return null;
    }
    await act(async () => {
        root.render(React.createElement(Probe));
    });
    return { state, applied };
}

describe('usePendingComposerText', () => {
    test('"Add to chat" appends to the draft and brings a minimized composer back', async () => {
        const { state } = await mount('draft');
        expect(state.minimized).toBe(true);
        await act(async () => {
            useInputStore.getState().setPendingInputText('quoted answer', 'append');
        });
        expect(state.message).toBe('draft\n\nquoted answer\n\n');
        expect(state.minimized).toBe(false);
    });

    test('a reverted prompt fills an empty composer and brings it back', async () => {
        const { state } = await mount('');
        await act(async () => {
            useInputStore.getState().setPendingRevertText('reverted prompt');
        });
        expect(state.message).toBe('reverted prompt');
        expect(state.minimized).toBe(false);
    });

    test('a reverted prompt never overwrites a draft, and then leaves the composer minimized', async () => {
        const { state, applied } = await mount('my draft');
        await act(async () => {
            useInputStore.getState().setPendingRevertText('reverted prompt');
        });
        expect(state.message).toBe('my draft');
        expect(state.minimized).toBe(true);
        expect(applied.count).toBe(0);
    });

    test('without pending text the composer stays minimized', async () => {
        const { state, applied } = await mount('draft');
        await act(async () => {
            useInputStore.getState().setPendingInputText(null);
        });
        expect(state.minimized).toBe(true);
        expect(applied.count).toBe(0);
    });
});
