// Security policy for the desktop browser profile (`persist:pichamber-browser`).
//
// Visited sites are untrusted. They render in an Electron <webview> on their
// own partition, never in PiChamber's origin, and get no preload, no Node and
// no permissions beyond fullscreen and sanitized clipboard writes. The main
// process enforces this, so a renderer that asks for more does not get it.

export const BROWSER_PARTITION = 'persist:pichamber-browser';

const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

export const isAllowedBrowserUrl = (rawUrl) => {
  if (typeof rawUrl !== 'string') return false;
  const value = rawUrl.trim();
  if (value === 'about:blank') return true;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

const isAllowedBrowserPermission = (permission) => ALLOWED_PERMISSIONS.has(permission);

/**
 * Rewrites the preferences of a <webview> about to attach. Returns false when
 * the attach must be cancelled (start URL with a disallowed scheme). An empty
 * `src` means about:blank.
 */
export const applyWebviewAttachPolicy = (webPreferences, params) => {
  delete webPreferences.preload;
  delete webPreferences.preloadURL;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webviewTag = false;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.partition = BROWSER_PARTITION;

  const src = typeof params?.src === 'string' && params.src.trim() ? params.src : 'about:blank';
  return isAllowedBrowserUrl(src);
};

/** Guards one embedder webContents: every <webview> it attaches gets the policy. */
export const guardWebviewAttach = (contents, log) => {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    if (applyWebviewAttachPolicy(webPreferences, params)) return;
    event.preventDefault();
    log?.warn?.('[browser] blocked <webview> with a disallowed start URL');
  });
};

/**
 * Guards a <webview> guest: its main frame only loads http(s) or about:blank.
 * `will-navigate` covers page-initiated navigations, `will-redirect` the
 * server redirects of any main frame load. Loads requested by the
 * embedder (`<webview>.loadURL()` and `src` changes) reach the guest as
 * `guest.loadURL()` in this process and fire no `will-navigate`, so that
 * entry point gets the same rule.
 */
export const guardWebviewNavigation = (contents, log) => {
  contents.on('will-navigate', (event, url) => {
    if (isAllowedBrowserUrl(url)) return;
    event.preventDefault();
    log?.warn?.('[browser] blocked a navigation with a disallowed scheme');
  });

  contents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (!(event.isMainFrame ?? isMainFrame)) return;
    if (isAllowedBrowserUrl(event.url ?? url)) return;
    event.preventDefault();
    log?.warn?.('[browser] blocked a redirect with a disallowed scheme');
  });

  const loadURL = contents.loadURL.bind(contents);
  contents.loadURL = (url, options) => {
    if (isAllowedBrowserUrl(url)) return loadURL(url, options);
    log?.warn?.('[browser] blocked a load with a disallowed scheme');
    return Promise.reject(new Error('The browser only loads http, https and about:blank'));
  };
};

/** Denies every permission of the browser profile except the allowed ones. */
export const applyBrowserSessionPolicy = (browserSession) => {
  browserSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(isAllowedBrowserPermission(permission));
  });
  browserSession.setPermissionCheckHandler((_contents, permission) => isAllowedBrowserPermission(permission));
  browserSession.setDevicePermissionHandler(() => false);
};
