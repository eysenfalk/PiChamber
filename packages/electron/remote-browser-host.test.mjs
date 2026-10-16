import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { BROWSER_PARTITION } from './browser-profile-policy.mjs';
import { REMOTE_BROWSER_WINDOW_OPTIONS, createRemoteBrowserHost } from './remote-browser-host.mjs';

const makeImage = (label) => ({ toJPEG: (quality) => Buffer.from(`${label}@${quality}`) });

const makeHarness = () => {
  const windows = [];
  const browserSession = new EventEmitter();
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.contentSize = [options.width, options.height];
      const wc = new EventEmitter();
      Object.assign(wc, {
        calls: [],
        url: '',
        history: { back: false, forward: false },
        painting: true,
        loadURL: async (url) => { wc.calls.push(['loadURL', url]); wc.url = url; },
        getURL: () => wc.url,
        getTitle: () => 'Title',
        isLoading: () => false,
        reload: () => wc.calls.push(['reload']),
        stop: () => wc.calls.push(['stop']),
        focus: () => wc.calls.push(['focus']),
        insertText: (text) => wc.calls.push(['insertText', text]),
        sendInputEvent: (event) => wc.calls.push(['input', event]),
        setFrameRate: (rate) => wc.calls.push(['setFrameRate', rate]),
        startPainting: () => { wc.painting = true; },
        stopPainting: () => { wc.painting = false; },
        invalidate: () => {},
        setWindowOpenHandler: (handler) => { wc.openHandler = handler; },
        navigationHistory: {
          canGoBack: () => wc.history.back,
          canGoForward: () => wc.history.forward,
          goBack: () => wc.calls.push(['goBack']),
          goForward: () => wc.calls.push(['goForward']),
        },
      });
      this.webContents = wc;
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    setContentSize(width, height) { this.contentSize = [width, height]; }
  }
  let clock = 0;
  const pendingTimers = new Map();
  let nextTimer = 1;
  const timers = {
    setTimeout: (fn, ms) => { const id = nextTimer++; pendingTimers.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout: (id) => { pendingTimers.delete(id); },
  };
  const advance = (ms) => {
    clock += ms;
    for (const [id, timer] of [...pendingTimers]) {
      if (timer.at <= clock) { pendingTimers.delete(id); timer.fn(); }
    }
  };
  const host = createRemoteBrowserHost({
    BrowserWindow: FakeWindow,
    getBrowserSession: () => browserSession,
    log: { warn() {} },
    idleCloseMs: 1000,
    frameRate: 10,
    timers,
    now: () => clock,
  });
  const makeViewer = () => {
    const viewer = { frames: [], states: [], notices: [] };
    viewer.listener = {
      onFrame: (jpeg) => viewer.frames.push(String(jpeg)),
      onState: (state) => viewer.states.push(state),
      onNotice: (notice) => viewer.notices.push(notice),
    };
    return viewer;
  };
  return { host, windows, browserSession, advance, makeViewer };
};

test('the page window is hidden, offscreen and isolated on the browser profile', () => {
  assert.equal(REMOTE_BROWSER_WINDOW_OPTIONS.show, false);
  assert.deepEqual(REMOTE_BROWSER_WINDOW_OPTIONS.webPreferences, {
    offscreen: true,
    partition: BROWSER_PARTITION,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: false,
  });
  const { host, windows, makeViewer } = makeHarness();
  assert.equal(windows.length, 0, 'no window before a viewer attaches');
  host.attach(makeViewer().listener);
  assert.equal(windows.length, 1);
  assert.equal(host.ownsWindow(windows[0]), true);
  assert.equal(host.ownsWindow({}), false);
  assert.deepEqual(windows[0].webContents.calls.find(([name]) => name === 'setFrameRate'), ['setFrameRate', 10]);
});

test('only one frame is in flight and only the latest paint is sent', () => {
  const { host, windows, advance, makeViewer } = makeHarness();
  const viewer = makeViewer();
  const session = host.attach(viewer.listener);
  const wc = windows[0].webContents;
  wc.emit('paint', {}, {}, makeImage('a'));
  wc.emit('paint', {}, {}, makeImage('b'));
  wc.emit('paint', {}, {}, makeImage('c'));
  assert.deepEqual(viewer.frames, ['a@70']);
  session.handle({ type: 'ack' });
  assert.deepEqual(viewer.frames, ['a@70'], 'the frame interval holds the next frame back');
  advance(100);
  assert.deepEqual(viewer.frames, ['a@70', 'c@70']);
  advance(500);
  assert.deepEqual(viewer.frames, ['a@70', 'c@70'], 'no new paint, no new frame');
});

test('input reaches the page as navigation, mouse, wheel and keyboard events', () => {
  const { host, windows, makeViewer } = makeHarness();
  const session = host.attach(makeViewer().listener);
  const wc = windows[0].webContents;
  wc.calls.length = 0;
  wc.history.back = true;
  session.handle({ type: 'navigate', url: 'http://10.0.0.5/' });
  session.handle({ type: 'back' });
  session.handle({ type: 'forward' });
  session.handle({ type: 'tap', x: 5, y: 6 });
  session.handle({ type: 'scroll', x: 1, y: 2, deltaX: 0, deltaY: 300 });
  session.handle({ type: 'text', text: 'hi' });
  session.handle({ type: 'key', key: 'ArrowDown' });
  session.handle({ type: 'resize', width: 400, height: 800 });
  assert.deepEqual(wc.calls, [
    ['loadURL', 'http://10.0.0.5/'],
    ['goBack'],
    ['focus'],
    ['input', { type: 'mouseMove', x: 5, y: 6 }],
    ['input', { type: 'mouseDown', x: 5, y: 6, button: 'left', clickCount: 1 }],
    ['input', { type: 'mouseUp', x: 5, y: 6, button: 'left', clickCount: 1 }],
    ['input', { type: 'mouseWheel', x: 1, y: 2, deltaX: -0, deltaY: -300, wheelTicksX: -0, wheelTicksY: -3, hasPreciseScrollingDeltas: true, canScroll: true }],
    ['focus'],
    ['insertText', 'hi'],
    ['focus'],
    ['input', { type: 'keyDown', keyCode: 'Down' }],
    ['input', { type: 'keyUp', keyCode: 'Down' }],
  ]);
  assert.deepEqual(windows[0].contentSize, [400, 800]);
});

test('popups load in place only for browser URLs', () => {
  const { host, windows, makeViewer } = makeHarness();
  host.attach(makeViewer().listener);
  const wc = windows[0].webContents;
  assert.deepEqual(wc.openHandler({ url: 'https://example.com/popup' }), { action: 'deny' });
  assert.deepEqual(wc.openHandler({ url: 'file:///etc/passwd' }), { action: 'deny' });
  const loads = wc.calls.filter(([name]) => name === 'loadURL').map(([, url]) => url);
  assert.deepEqual(loads, ['about:blank', 'https://example.com/popup']);
});

test('state follows navigation and downloads of the page are cancelled', () => {
  const { host, windows, browserSession, makeViewer } = makeHarness();
  const viewer = makeViewer();
  host.attach(viewer.listener);
  const wc = windows[0].webContents;
  wc.url = 'http://10.0.0.5/';
  wc.emit('did-navigate');
  assert.deepEqual(viewer.states.at(-1), { url: 'http://10.0.0.5/', title: 'Title', canGoBack: false, canGoForward: false, loading: false });

  const ownDownload = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  browserSession.emit('will-download', ownDownload, {}, wc);
  assert.equal(ownDownload.defaultPrevented, true);
  assert.deepEqual(viewer.notices, ['download-blocked']);
  const desktopDownload = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  browserSession.emit('will-download', desktopDownload, {}, new EventEmitter());
  assert.equal(desktopDownload.defaultPrevented, false, 'the desktop browser tab keeps its own download handling');
});

test('a new viewer replaces the old one, whose handle goes inert', () => {
  const { host, windows, makeViewer } = makeHarness();
  const first = makeViewer();
  const second = makeViewer();
  const firstSession = host.attach(first.listener);
  const secondSession = host.attach(second.listener);
  const wc = windows[0].webContents;
  wc.calls.length = 0;
  firstSession.handle({ type: 'reload' });
  firstSession.detach();
  assert.deepEqual(wc.calls, []);
  assert.equal(wc.painting, true, 'the stale detach does not stop the new viewer');
  wc.emit('paint', {}, {}, makeImage('x'));
  assert.deepEqual(first.frames, []);
  assert.deepEqual(second.frames, ['x@70']);
  secondSession.handle({ type: 'reload' });
  assert.deepEqual(wc.calls, [['reload']]);
  assert.equal(windows.length, 1, 'both viewers share one page');
});

test('without a viewer the page stops painting and closes after the idle time', () => {
  const { host, windows, advance, makeViewer } = makeHarness();
  const session = host.attach(makeViewer().listener);
  session.detach();
  assert.equal(windows[0].webContents.painting, false);
  advance(999);
  assert.equal(windows[0].destroyed, false);
  host.attach(makeViewer().listener).detach();
  advance(999);
  assert.equal(windows[0].destroyed, false, 'reattaching restarts the idle time');
  advance(1);
  assert.equal(windows[0].destroyed, true);
  assert.equal(host.ownsWindow(windows[0]), false);
  host.attach(makeViewer().listener);
  assert.equal(windows.length, 2, 'the next viewer gets a fresh page');
  host.shutdown();
  assert.equal(windows[1].destroyed, true);
});
