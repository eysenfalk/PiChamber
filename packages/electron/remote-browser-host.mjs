// Remote browser host (#163, ADR 0012): renders the owner's browser page
// offscreen in the desktop app, on the browser profile, and hands frames and
// page state to the PiChamber server, which streams them to a phone or web
// client. The server validates every client message before `handle` sees it.
//
// One page, one viewer: attaching a new viewer replaces the previous one.
// Without a viewer the page stops painting, and after `idleCloseMs` the
// hidden window closes; the next viewer starts a fresh page.

import { BROWSER_PARTITION, guardWebviewNavigation, isAllowedBrowserUrl } from './browser-profile-policy.mjs';

const DEFAULT_IDLE_CLOSE_MS = 10 * 60 * 1000;
const DEFAULT_FRAME_RATE = 15;
const JPEG_QUALITY = 70;
const DEFAULT_VIEWPORT = { width: 390, height: 844 };

export const REMOTE_BROWSER_WINDOW_OPTIONS = Object.freeze({
  show: false,
  ...DEFAULT_VIEWPORT,
  useContentSize: true,
  webPreferences: {
    offscreen: true,
    partition: BROWSER_PARTITION,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: false,
  },
});

const STATE_EVENTS = ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated'];

// Electron key codes for the protocol's key names.
const KEY_CODES = {
  Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab', Escape: 'Escape', Delete: 'Delete',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
};

export const createRemoteBrowserHost = ({
  BrowserWindow,
  getBrowserSession,
  log,
  idleCloseMs = DEFAULT_IDLE_CLOSE_MS,
  frameRate = DEFAULT_FRAME_RATE,
  timers = { setTimeout, clearTimeout },
  now = Date.now,
}) => {
  const frameIntervalMs = 1000 / frameRate;
  let window = null;
  let viewer = null;
  let idleTimer = null;
  let flushTimer = null;
  let awaitingAck = false;
  let pendingImage = null;
  let lastFrameAt = -Infinity;
  let downloadsGuarded = false;

  const contents = () => (window && !window.isDestroyed() ? window.webContents : null);

  const readState = () => {
    const wc = contents();
    if (!wc) return null;
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading(),
    };
  };

  const emitState = () => {
    const state = viewer && readState();
    if (state) viewer.onState(state);
  };

  const clearFlushTimer = () => {
    if (flushTimer) timers.clearTimeout(flushTimer);
    flushTimer = null;
  };

  // One frame in flight: the next frame goes out after the viewer acked the
  // previous one and the frame interval has passed. Only the latest paint is
  // kept, so a slow viewer skips frames instead of queueing them.
  const flush = () => {
    if (!viewer || awaitingAck || !pendingImage) return;
    const waitMs = lastFrameAt + frameIntervalMs - now();
    if (waitMs > 0) {
      if (!flushTimer) flushTimer = timers.setTimeout(() => { flushTimer = null; flush(); }, waitMs);
      return;
    }
    const image = pendingImage;
    pendingImage = null;
    awaitingAck = true;
    lastFrameAt = now();
    viewer.onFrame(image.toJPEG(JPEG_QUALITY));
  };

  const guardDownloads = () => {
    if (downloadsGuarded) return;
    downloadsGuarded = true;
    getBrowserSession().on('will-download', (event, _item, source) => {
      if (!source || source !== contents()) return;
      event.preventDefault();
      viewer?.onNotice('download-blocked');
    });
  };

  const closeWindow = () => {
    clearFlushTimer();
    if (idleTimer) timers.clearTimeout(idleTimer);
    idleTimer = null;
    const current = window;
    window = null;
    pendingImage = null;
    if (current && !current.isDestroyed()) current.destroy();
  };

  const ensureWindow = () => {
    if (contents()) return window;
    guardDownloads();
    const created = new BrowserWindow(REMOTE_BROWSER_WINDOW_OPTIONS);
    window = created;
    const wc = created.webContents;
    guardWebviewNavigation(wc, log);
    wc.setWindowOpenHandler(({ url }) => {
      if (isAllowedBrowserUrl(url)) void wc.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    wc.setFrameRate(frameRate);
    wc.on('paint', (_event, _dirty, image) => {
      pendingImage = image;
      flush();
    });
    for (const name of STATE_EVENTS) wc.on(name, emitState);
    wc.on('render-process-gone', () => {
      viewer?.onNotice('page-crashed');
      closeWindow();
    });
    created.on('closed', () => { if (window === created) window = null; });
    void wc.loadURL('about:blank').catch(() => {});
    return created;
  };

  const handle = (message) => {
    const target = ensureWindow();
    const wc = target.webContents;
    switch (message.type) {
      case 'navigate':
        void wc.loadURL(message.url).catch((error) => log?.warn?.('[remote-browser] load failed:', error?.message));
        return;
      case 'back':
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        return;
      case 'forward':
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        return;
      case 'reload':
        wc.reload();
        return;
      case 'stop':
        wc.stop();
        return;
      case 'resize':
        target.setContentSize(message.width, message.height);
        wc.invalidate();
        return;
      case 'tap':
        wc.focus();
        wc.sendInputEvent({ type: 'mouseMove', x: message.x, y: message.y });
        wc.sendInputEvent({ type: 'mouseDown', x: message.x, y: message.y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: message.x, y: message.y, button: 'left', clickCount: 1 });
        return;
      case 'scroll':
        // Protocol deltas follow the DOM (positive scrolls down); Electron's
        // wheel deltas point the other way and need wheel ticks to scroll.
        wc.sendInputEvent({
          type: 'mouseWheel',
          x: message.x,
          y: message.y,
          deltaX: -message.deltaX,
          deltaY: -message.deltaY,
          wheelTicksX: -message.deltaX / 100,
          wheelTicksY: -message.deltaY / 100,
          hasPreciseScrollingDeltas: true,
          canScroll: true,
        });
        return;
      case 'text':
        wc.focus();
        wc.insertText(message.text);
        return;
      case 'key': {
        const keyCode = KEY_CODES[message.key];
        if (!keyCode) return;
        wc.focus();
        wc.sendInputEvent({ type: 'keyDown', keyCode });
        if (message.key === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r' });
        wc.sendInputEvent({ type: 'keyUp', keyCode });
        return;
      }
      case 'ack':
        awaitingAck = false;
        flush();
        return;
      default:
        log?.warn?.('[remote-browser] ignored an unknown message type');
    }
  };

  /** Makes `listener` the only viewer. Returns its handle; stale handles do nothing. */
  const attach = (listener) => {
    if (idleTimer) timers.clearTimeout(idleTimer);
    idleTimer = null;
    clearFlushTimer();
    viewer = listener;
    awaitingAck = false;
    pendingImage = null;
    lastFrameAt = -Infinity;
    const wc = ensureWindow().webContents;
    wc.startPainting();
    wc.invalidate();
    emitState();
    return {
      handle: (message) => { if (viewer === listener) handle(message); },
      detach: () => {
        if (viewer !== listener) return;
        viewer = null;
        clearFlushTimer();
        pendingImage = null;
        contents()?.stopPainting();
        idleTimer = timers.setTimeout(closeWindow, idleCloseMs);
        idleTimer?.unref?.();
      },
    };
  };

  return {
    attach,
    /** True for the hidden page window, which is not an app window. */
    ownsWindow: (candidate) => Boolean(candidate) && candidate === window,
    shutdown: () => {
      viewer = null;
      closeWindow();
    },
  };
};
