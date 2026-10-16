import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  BROWSER_PARTITION,
  applyBrowserSessionPolicy,
  applyWebviewAttachPolicy,
  guardWebviewAttach,
  guardWebviewNavigation,
  isAllowedBrowserUrl,
} from './browser-profile-policy.mjs';

const makeEvent = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });

test('only http, https and about:blank are browser URLs', () => {
  for (const url of ['https://example.com/', 'http://127.0.0.1:8080/x', 'about:blank', ' https://a.b ']) {
    assert.equal(isAllowedBrowserUrl(url), true, url);
  }
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'chrome://gpu', 'devtools://x', 'pichamber-ui://app/', 'about:config', '', 'not a url', null, undefined, 42]) {
    assert.equal(isAllowedBrowserUrl(url), false, String(url));
  }
});

test('an attaching webview loses preload and Node and lands on the browser partition', () => {
  const prefs = {
    preload: '/evil/preload.js',
    preloadURL: 'file:///evil/preload.js',
    nodeIntegration: true,
    nodeIntegrationInSubFrames: true,
    contextIsolation: false,
    sandbox: false,
    webviewTag: true,
    webSecurity: false,
    allowRunningInsecureContent: true,
    partition: 'persist:something-else',
  };

  assert.equal(applyWebviewAttachPolicy(prefs, { src: 'https://example.com/' }), true);
  assert.deepEqual(prefs, {
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    partition: BROWSER_PARTITION,
  });
});

test('a webview without src starts on about:blank and is allowed', () => {
  assert.equal(applyWebviewAttachPolicy({}, {}), true);
  assert.equal(applyWebviewAttachPolicy({}, { src: '' }), true);
});

test('the attach guard cancels a webview whose start URL has another scheme', () => {
  const contents = new EventEmitter();
  const warnings = [];
  guardWebviewAttach(contents, { warn: (message) => warnings.push(message) });

  const blocked = makeEvent();
  const blockedPrefs = { nodeIntegration: true };
  contents.emit('will-attach-webview', blocked, blockedPrefs, { src: 'file:///etc/passwd' });
  assert.equal(blocked.defaultPrevented, true);
  assert.equal(blockedPrefs.nodeIntegration, false);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /passwd/, 'the blocked URL is not logged');

  const allowed = makeEvent();
  contents.emit('will-attach-webview', allowed, {}, { src: 'https://example.com/' });
  assert.equal(allowed.defaultPrevented, false);
});

const makeGuest = () => {
  const contents = new EventEmitter();
  contents.loaded = [];
  contents.loadURL = function loadURL(url) { this.loaded.push(url); return Promise.resolve(); };
  return contents;
};

test('the embedder cannot load other schemes into the webview', async () => {
  const contents = makeGuest();
  guardWebviewNavigation(contents);

  for (const url of ['file:///etc/passwd', 'data:text/html,x', 'chrome://gpu', 'javascript:alert(1)']) {
    await assert.rejects(contents.loadURL(url), /only loads http/, url);
  }
  await contents.loadURL('https://example.com/');
  await contents.loadURL('about:blank');
  assert.deepEqual(contents.loaded, ['https://example.com/', 'about:blank']);
});

test('pages inside the webview cannot navigate the main frame to other schemes', () => {
  const contents = makeGuest();
  guardWebviewNavigation(contents);

  const blocked = makeEvent();
  contents.emit('will-navigate', blocked, 'file:///home/user/.ssh/id_ed25519');
  assert.equal(blocked.defaultPrevented, true);

  const allowed = makeEvent();
  contents.emit('will-navigate', allowed, 'https://accounts.example.com/login');
  assert.equal(allowed.defaultPrevented, false);
});

test('server redirects of the main frame cannot leave http and https', () => {
  const contents = makeGuest();
  const warnings = [];
  guardWebviewNavigation(contents, { warn: (message) => warnings.push(message) });

  // Electron passes the details on the event and, deprecated, as arguments.
  const redirect = (url, isMainFrame = true) => {
    const event = Object.assign(makeEvent(), { url, isMainFrame });
    contents.emit('will-redirect', event, url, false, isMainFrame);
    return event.defaultPrevented;
  };

  for (const url of ['pichamber-ui://app/test', 'file:///etc/passwd', 'data:text/html,x', 'chrome://gpu']) {
    assert.equal(redirect(url), true, url);
  }
  assert.equal(redirect('https://accounts.example.com/callback'), false);
  assert.equal(redirect('http://127.0.0.1:8080/after-login'), false);
  assert.equal(warnings.length, 4);
  assert.doesNotMatch(warnings.join(' '), /passwd|pichamber-ui/, 'the blocked URL is not logged');
});

test('the browser profile denies every permission except fullscreen and clipboard writes', () => {
  const handlers = {};
  applyBrowserSessionPolicy({
    setPermissionRequestHandler: (handler) => { handlers.request = handler; },
    setPermissionCheckHandler: (handler) => { handlers.check = handler; },
    setDevicePermissionHandler: (handler) => { handlers.device = handler; },
  });

  const request = (permission) => {
    let granted;
    handlers.request(null, permission, (value) => { granted = value; }, {});
    return granted;
  };

  for (const permission of ['fullscreen', 'clipboard-sanitized-write']) {
    assert.equal(request(permission), true, permission);
    assert.equal(handlers.check(null, permission, 'https://example.com', {}), true, permission);
  }
  for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'midi', 'midiSysex', 'pointerLock', 'openExternal', 'display-capture', 'window-management', 'unknown', 'idle-detection', 'storage-access', 'hid', 'serial', 'usb']) {
    assert.equal(request(permission), false, permission);
    assert.equal(handlers.check(null, permission, 'https://example.com', {}), false, permission);
  }
  assert.equal(handlers.device({ deviceType: 'usb' }), false);
});
