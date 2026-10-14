import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

// Mounted-pane tests for the remote browser lifecycle (#163 S3): app background
// and resume, runtime endpoint switches, and the native IME Backspace path.
// The client module is replaced as a whole by a subclass of the real client
// with a controlled socket, so the pane runs its real lifecycle code.

const realClientModule = await import('@/lib/browser/remoteBrowserClient');

class FakeSocket {
  readyState = 0;
  binaryType = 'arraybuffer';
  closed = false;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
}

const sockets: FakeSocket[] = [];
const openSockets = () => sockets.filter((socket) => !socket.closed);
let statusReads = 0;
let heldStatus: Array<(value: 'available') => void> | null = null;

mock.module('@/lib/browser/remoteBrowserClient', () => ({
  ...realClientModule,
  fetchRemoteBrowserAvailability: () => {
    statusReads += 1;
    if (heldStatus) {
      const queue = heldStatus;
      return new Promise<'available'>((resolve) => { queue.push(resolve); });
    }
    return Promise.resolve('available' as const);
  },
  RemoteBrowserClient: class extends realClientModule.RemoteBrowserClient {
    constructor(listener: ConstructorParameters<typeof realClientModule.RemoteBrowserClient>[0]) {
      super(listener, {
        refreshToken: async () => 'test-token',
        clearToken: () => {},
        openSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket as never;
        },
        setTimer: (callback: () => void, ms: number) => setTimeout(callback, ms),
        clearTimer: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      });
    }
  },
}));

const appStateListeners = new Set<(state: { isActive: boolean }) => void>();
mock.module('@capacitor/app', () => ({
  App: {
    addListener: async (name: string, listener: (state: { isActive: boolean }) => void) => {
      if (name === 'appStateChange') appStateListeners.add(listener);
      return { remove: async () => { appStateListeners.delete(listener); } };
    },
  },
}));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/ui/button', () => ({
  Button: (props: Record<string, unknown> & { children?: React.ReactNode }) => React.createElement(
    'button',
    { type: props.type, disabled: props.disabled, onClick: props.onClick, 'aria-label': props['aria-label'] },
    props.children,
  ),
}));
mock.module('@/components/ui', () => ({ toast: { error() {}, info() {} } }));

type Listener = (event: unknown) => void;
type FakeNode = {
  nodeType: number;
  nodeName: string;
  tagName: string;
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  listeners: Map<string, Listener[]>;
  value?: string;
  [key: string]: unknown;
};

const addListener = (target: { listeners: Map<string, Listener[]> }, type: string, listener: Listener) => {
  target.listeners.set(type, [...(target.listeners.get(type) ?? []), listener]);
};
const removeListener = (target: { listeners: Map<string, Listener[]> }, type: string, listener: Listener) => {
  target.listeners.set(type, (target.listeners.get(type) ?? []).filter((entry) => entry !== listener));
};
const fire = (target: { listeners: Map<string, Listener[]> }, event: { type: string }) => {
  for (const listener of [...(target.listeners.get(event.type) ?? [])]) listener(event);
};

function makeNode(tag: string, ownerDocument: unknown): FakeNode {
  return {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    ownerDocument,
    parentNode: null,
    childNodes: [],
    listeners: new Map(),
    style: { setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {} },
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return null; },
    addEventListener(this: FakeNode, type: string, listener: Listener) { addListener(this, type, listener); },
    removeEventListener(this: FakeNode, type: string, listener: Listener) { removeListener(this, type, listener); },
    appendChild(this: FakeNode, child: FakeNode) { this.childNodes.push(child); child.parentNode = this; return child; },
    insertBefore(this: FakeNode, child: FakeNode, ref: FakeNode) {
      const index = this.childNodes.indexOf(ref);
      if (index < 0) this.childNodes.push(child); else this.childNodes.splice(index, 0, child);
      child.parentNode = this;
      return child;
    },
    removeChild(this: FakeNode, child: FakeNode) {
      this.childNodes = this.childNodes.filter((entry) => entry !== child);
      child.parentNode = null;
      return child;
    },
    contains() { return false; },
    focus() {},
    blur() {},
    textContent: '',
  };
}

function installDom() {
  let hidden = false;
  const document = {
    nodeType: 9,
    nodeName: '#document',
    parentNode: null,
    childNodes: [],
    listeners: new Map<string, Listener[]>(),
    activeElement: null,
    // react-dom feature-detects native input events through this property.
    oninput: null,
    get visibilityState() { return hidden ? 'hidden' : 'visible'; },
    createElement(tag: string) { return makeNode(tag, document); },
    createElementNS(_ns: string, tag: string) { return makeNode(tag, document); },
    createTextNode(text: string) { return { nodeType: 3, nodeName: '#text', textContent: text, parentNode: null }; },
    addEventListener(type: string, listener: Listener) { addListener(document, type, listener); },
    removeEventListener(type: string, listener: Listener) { removeListener(document, type, listener); },
  } as Record<string, unknown> & { listeners: Map<string, Listener[]> };
  const win = {
    document,
    listeners: new Map<string, Listener[]>(),
    location: { protocol: 'capacitor:', origin: 'capacitor://localhost', href: 'capacitor://localhost/', search: '' },
    navigator: { userAgent: 'test' },
    addEventListener(type: string, listener: Listener) { addListener(win, type, listener); },
    removeEventListener(type: string, listener: Listener) { removeListener(win, type, listener); },
    dispatchEvent(event: { type: string }) { fire(win, event); return true; },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    Element: class {},
    HTMLElement: class {},
    HTMLIFrameElement: class {},
  } as Record<string, unknown> & { listeners: Map<string, Listener[]> };
  win.window = win;
  document.defaultView = win;
  document.body = makeNode('body', document);
  document.documentElement = makeNode('html', document);

  const g = globalThis as Record<string, unknown>;
  const keys = ['document', 'window', 'navigator', 'location', 'Element', 'HTMLElement', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const previous = Object.fromEntries(keys.map((key) => [key, g[key]]));
  Object.assign(g, {
    document,
    window: win,
    navigator: win.navigator,
    location: win.location,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    HTMLIFrameElement: win.HTMLIFrameElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0) as unknown as number,
    cancelAnimationFrame: (handle: number) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
  });

  return {
    container: makeNode('div', document),
    setHidden(next: boolean) {
      hidden = next;
      fire(document, { type: 'visibilitychange' });
    },
    dispatchWindow(type: string, detail: unknown) { fire(win, { type, detail } as { type: string }); },
    restore() { Object.assign(g, previous); },
  };
}

const flush = async () => {
  for (let round = 0; round < 6; round += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
};

// react-dom must see a document when it loads.
const bootDom = installDom();
const { createRoot } = await import('react-dom/client');
const { RemoteBrowserPane } = await import('./RemoteBrowserPane');
bootDom.restore();

let dom: ReturnType<typeof installDom>;
let root: Root;

const render = async (visible: boolean) => {
  await act(async () => root.render(<RemoteBrowserPane visible={visible} density="touch" />));
  await flush();
};

const setAppActive = async (isActive: boolean) => {
  await act(async () => { for (const listener of appStateListeners) listener({ isActive }); });
  await flush();
};

const setHidden = async (hidden: boolean) => {
  await act(async () => dom.setHidden(hidden));
  await flush();
};

const findTextarea = (node: FakeNode): FakeNode | undefined => {
  if (node.tagName === 'TEXTAREA') return node;
  for (const child of node.childNodes) {
    const found = findTextarea(child);
    if (found) return found;
  }
  return undefined;
};

// Native dispatch: the element's own listeners, then the React root listeners it bubbles to.
const dispatchNative = async (target: FakeNode, type: string, fields: Record<string, unknown>) => {
  const event = {
    type,
    target,
    srcElement: target,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
    ...fields,
  };
  await act(async () => {
    fire(target, event);
    fire(dom.container, event);
  });
  return event;
};

beforeEach(async () => {
  sockets.length = 0;
  statusReads = 0;
  heldStatus = null;
  appStateListeners.clear();
  dom = installDom();
  root = createRoot(dom.container as unknown as HTMLElement);
  await render(true);
  expect(sockets.length).toBe(1);
  await act(async () => sockets[0].open());
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.restore();
});

describe('RemoteBrowserPane lifecycle', () => {
  test('releases the viewer in the background and reconnects on resume only while selected', async () => {
    await setHidden(true);
    expect(sockets[0].closed).toBe(true);
    expect(openSockets().length).toBe(0);

    await setHidden(false);
    expect(sockets.length).toBe(2);
    expect(openSockets().length).toBe(1);

    // Native pause/resume through Capacitor's appStateChange.
    await setAppActive(false);
    expect(openSockets().length).toBe(0);
    await setAppActive(true);
    expect(sockets.length).toBe(3);
    expect(openSockets().length).toBe(1);

    // Background, close the Browser tab, come back: no new viewer.
    await setHidden(true);
    await render(false);
    await setHidden(false);
    expect(sockets.length).toBe(3);
    expect(openSockets().length).toBe(0);
  });

  test('closing the pane closes its socket and reopening starts exactly one', async () => {
    await render(false);
    expect(sockets[0].closed).toBe(true);
    await render(true);
    expect(sockets.length).toBe(2);
    expect(openSockets().length).toBe(1);
  });

  test('an endpoint switch releases the old viewer and starts one client at the new endpoint', async () => {
    const toRelay = { runtimeKey: 'laptop', previousRuntimeKey: 'laptop', previousApiBaseUrl: 'http://100.64.0.1:3000', apiBaseUrl: 'https://relay.example' };
    await act(async () => dom.dispatchWindow('pichamber:runtime-endpoint-will-change', toRelay));
    expect(sockets[0].closed).toBe(true);
    await act(async () => dom.dispatchWindow('pichamber:runtime-endpoint-changed', toRelay));
    await flush();
    expect(statusReads).toBe(2);
    expect(sockets.length).toBe(2);
    expect(openSockets().length).toBe(1);

    // Switch back while the status read is still pending, then switch again;
    // the late answer of the superseded read must not start a second client.
    heldStatus = [];
    const toLan = { ...toRelay, previousApiBaseUrl: toRelay.apiBaseUrl, apiBaseUrl: toRelay.previousApiBaseUrl };
    await act(async () => {
      dom.dispatchWindow('pichamber:runtime-endpoint-will-change', toLan);
      dom.dispatchWindow('pichamber:runtime-endpoint-changed', toLan);
    });
    await flush();
    expect(openSockets().length).toBe(0);
    await act(async () => {
      dom.dispatchWindow('pichamber:runtime-endpoint-will-change', toRelay);
      dom.dispatchWindow('pichamber:runtime-endpoint-changed', toRelay);
    });
    await flush();
    expect(heldStatus.length).toBe(2);
    const [stale, current] = heldStatus;
    await act(async () => current('available'));
    await flush();
    await act(async () => stale('available'));
    await flush();
    expect(sockets.length).toBe(3);
    expect(openSockets().length).toBe(1);
  });
});

describe('RemoteBrowserPane keyboard input', () => {
  const sentKeys = () => sockets[0].sent.filter((message) => (message as { type: string }).type !== 'viewport');

  test('an IME deleteContentBackward on the empty field sends one Backspace', async () => {
    const input = findTextarea(dom.container)!;
    input.value = 'abc';
    await dispatchNative(input, 'input', { inputType: 'insertText', data: 'abc', isComposing: false });
    expect(input.value).toBe('');
    const before = await dispatchNative(input, 'beforeinput', { inputType: 'deleteContentBackward', data: null, isComposing: false });
    await dispatchNative(input, 'input', { inputType: 'deleteContentBackward', data: null, isComposing: false });
    expect(before.defaultPrevented).toBe(true);
    expect(sentKeys()).toEqual([{ type: 'text', text: 'abc' }, { type: 'key', key: 'Backspace' }]);
  });

  test('a physical Backspace is sent once even when beforeinput follows its keydown', async () => {
    const input = findTextarea(dom.container)!;
    await dispatchNative(input, 'keydown', { key: 'Backspace', keyCode: 8, isComposing: false });
    await dispatchNative(input, 'beforeinput', { inputType: 'deleteContentBackward', data: null, isComposing: false });
    await dispatchNative(input, 'keyup', { key: 'Backspace', keyCode: 8, isComposing: false });
    // The next IME deletion is a new keystroke again.
    await dispatchNative(input, 'beforeinput', { inputType: 'deleteContentBackward', data: null, isComposing: false });
    expect(sentKeys()).toEqual([{ type: 'key', key: 'Backspace' }, { type: 'key', key: 'Backspace' }]);
  });

  test('deletion inside a composition or of local text stays local', async () => {
    const input = findTextarea(dom.container)!;
    await dispatchNative(input, 'beforeinput', { inputType: 'deleteContentBackward', data: null, isComposing: true });
    input.value = 'ab';
    await dispatchNative(input, 'beforeinput', { inputType: 'deleteContentBackward', data: null, isComposing: false });
    expect(sentKeys()).toEqual([]);
  });

  test('the native listener is removed on unmount', async () => {
    const input = findTextarea(dom.container)!;
    expect(input.listeners.get('beforeinput')?.length).toBe(1);
    await act(async () => root.unmount());
    expect(input.listeners.get('beforeinput')?.length ?? 0).toBe(0);
    root = createRoot(dom.container as unknown as HTMLElement);
  });
});
