// === UPDATED MAIN.JS WITH LIVE PROXY SWITCHING ===
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  session,
  shell,
  Menu,
  webContents,
  clipboard,
  ShareMenu,
  protocol,
  screen,
} = require('electron');
const os = require('os');
const { pathToFileURL } = require('url');

const APP_DISPLAY_NAME = 'Bavarium Browser';
app.setName(APP_DISPLAY_NAME);
if (process.platform === 'win32') {
  app.setAppUserModelId('com.bavarium.browser');
}
process.title = APP_DISPLAY_NAME;

/** Second process exits; first can reopen a window via second-instance (Windows/Linux). */
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

const INCOGNITO_PARTITION = 'incognito';
const APP_USER_DATA_FOLDER = 'bavarium-browser';

function settingsFilePathEarly() {
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      APP_USER_DATA_FOLDER,
      'settings.json'
    );
  }
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      APP_USER_DATA_FOLDER,
      'settings.json'
    );
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    APP_USER_DATA_FOLDER,
    'settings.json'
  );
}

function readSettingsFileSyncEarly() {
  try {
    const p = settingsFilePathEarly();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (_) {}
  return {};
}

/** Must run before app is ready. Disabling display sync requires restart. */
function applyChromiumFrameFlagsFromDisk() {
  const s = readSettingsFileSyncEarly();
  const syncDisplay = s.fpsSyncDisplay !== false;
  if (!syncDisplay) {
    app.commandLine.appendSwitch('disable-gpu-vsync');
  }
}

if (gotTheLock) {
  applyChromiumFrameFlagsFromDisk();
}

function getAppBrowserWindows() {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
}

function dialogParentWindow() {
  return BrowserWindow.getFocusedWindow() || getAppBrowserWindows()[0] || null;
}

function broadcastToAllWindows(channel, ...args) {
  for (const w of getAppBrowserWindows()) {
    try {
      w.webContents.send(channel, ...args);
    } catch (_) {}
  }
}
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const { createSafeBrowsingService } = require('./safe-browsing');
const { clearGoogleSafeBrowsingCache } = require('./google-safe-browsing');

const HISTORY_LIMIT = 500;
const DOWNLOAD_RECORD_LIMIT = 200;

/** Real page metadata for proxied guest tabs (keyed by webContents.id). */
const guestSiteOriginByWcId = new Map();
const guestSitePageByWcId = new Map();

const GUEST_SITE_PAGE_PROBE = `(function() {
  var result = { origin: '', url: '', title: '', favicon: '' };
  function applyUrl(s) {
    if (!s || typeof s !== 'string') return '';
    var t = s.trim();
    if (!t) return '';
    try {
      if (!/^https?:\\/\\//i.test(t)) t = 'https://' + t;
      var u = new URL(t);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      var h = u.hostname.toLowerCase();
      if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return '';
      result.origin = u.origin;
      result.url = u.href;
      return u.href;
    } catch (e) { return ''; }
  }
  function applyTitle(t) {
    if (!t || typeof t !== 'string') return;
    t = t.trim();
    if (t) result.title = t;
  }
  function decodeUvEncodedUrl(href) {
    try {
      if (typeof __uv$config === 'undefined' || typeof __uv$config.decodeUrl !== 'function') return '';
      var u = new URL(href, location.origin);
      var path = u.pathname || '';
      var markers = ['/uv/service/', '/uv/'];
      for (var m = 0; m < markers.length; m++) {
        var idx = path.indexOf(markers[m]);
        if (idx === -1) continue;
        var enc = path.slice(idx + markers[m].length);
        if (!enc) continue;
        return __uv$config.decodeUrl(enc);
      }
    } catch (e) {}
    return '';
  }
  function decodeEmbeddedHttpUrl(href) {
    if (!href || typeof href !== 'string') return '';
    try {
      var m = href.match(/https?:\\/\\/[^\\s\"'<>]+/i);
      if (m && m[0]) return m[0];
      var u = new URL(href, location.origin);
      var blob = (u.pathname || '') + (u.search || '') + (u.hash || '');
      m = blob.match(/https?:\\/\\/[^\\s\"'<>]+/i);
      if (m && m[0]) return m[0];
      var parts = blob.split('/');
      for (var i = parts.length - 1; i >= 0; i--) {
        var p = parts[i];
        if (!p) continue;
        try {
          var dec = decodeURIComponent(p);
          if (/^https?:\\/\\//i.test(dec)) return dec;
        } catch (e2) {}
      }
    } catch (e) {}
    return '';
  }
  function readFrame(frameEl) {
    if (!frameEl) return;
    var doc = null;
    try {
      doc = frameEl.contentDocument;
      if (!doc && frameEl.contentWindow) doc = frameEl.contentWindow.document;
      if (doc) {
        if (doc.title) applyTitle(doc.title);
        if (doc.URL) {
          var fromDoc = decodeUvEncodedUrl(doc.URL) || decodeEmbeddedHttpUrl(doc.URL);
          if (fromDoc) applyUrl(fromDoc);
          else applyUrl(doc.URL);
        }
        var icon = doc.querySelector('link[rel~="icon"], link[rel="shortcut icon"]');
        if (icon && icon.href) {
          try {
            var iconUrl = new URL(icon.href, doc.baseURI || doc.URL).href;
            var iu = new URL(iconUrl);
            if (iu.hostname !== 'localhost' && iu.hostname !== '127.0.0.1') {
              result.favicon = iconUrl;
            }
          } catch (e) {}
        }
        var innerFrames = doc.querySelectorAll('iframe');
        for (var fi = 0; fi < innerFrames.length; fi++) {
          readFrame(innerFrames[fi]);
        }
      }
    } catch (e) {}
    try {
      if (frameEl.contentWindow && frameEl.contentWindow.location) {
        var href = frameEl.contentWindow.location.href;
        var decoded = decodeUvEncodedUrl(href) || decodeEmbeddedHttpUrl(href);
        if (decoded) applyUrl(decoded);
        else applyUrl(href);
      }
    } catch (e) {}
  }
  try {
    var q = new URLSearchParams(location.search);
    if (q.has('url')) applyUrl(decodeURIComponent(q.get('url')));
  } catch (e) {}
  var uvFrame = document.getElementById('uv-frame');
  if (uvFrame) {
    if (uvFrame.src) {
      var d = decodeUvEncodedUrl(uvFrame.src) || decodeEmbeddedHttpUrl(uvFrame.src);
      if (d) applyUrl(d);
      else applyUrl(uvFrame.src);
    }
    readFrame(uvFrame);
  }
  var sjFrame = document.getElementById('sj-frame');
  if (sjFrame) readFrame(sjFrame);
  if (!result.title && result.url) {
    try { result.title = new URL(result.url).hostname; } catch (e) {}
  }
  return result;
})()`;

/** Decode Scramjet/UV tunnel hrefs to a real https URL (runs in proxy guest page). */
const GUEST_TUNNEL_DECODE_CORE = `
  function decodeUvEncodedUrl(href) {
    try {
      if (typeof __uv$config === 'undefined' || typeof __uv$config.decodeUrl !== 'function') return '';
      var u = new URL(href, location.origin);
      var path = u.pathname || '';
      var markers = ['/uv/service/', '/uv/'];
      for (var m = 0; m < markers.length; m++) {
        var idx = path.indexOf(markers[m]);
        if (idx === -1) continue;
        var enc = path.slice(idx + markers[m].length);
        if (!enc) continue;
        return __uv$config.decodeUrl(enc);
      }
    } catch (e) {}
    return '';
  }
  function isRemoteHttpHref(url) {
    try {
      var u = new URL(url);
      var h = u.hostname.toLowerCase();
      return (
        (u.protocol === 'http:' || u.protocol === 'https:') &&
        h !== 'localhost' && h !== '127.0.0.1' && h !== '::1'
      );
    } catch (e) { return false; }
  }
  function decodeScramjetUrl(href) {
    try {
      var u = new URL(href, location.origin);
      var path = u.pathname || '';
      var marker = '/scramjet/';
      var idx = path.indexOf(marker);
      if (idx === -1) return '';
      var enc = path.slice(idx + marker.length);
      if (!enc) return '';
      var dec = decodeURIComponent(enc);
      if (/^https?:\\/\\//i.test(dec) && isRemoteHttpHref(dec)) return dec;
    } catch (e) {}
    return '';
  }
  function decodeEmbeddedHttpUrl(href) {
    if (!href || typeof href !== 'string') return '';
    var sj = decodeScramjetUrl(href);
    if (sj) return sj;
    try {
      var m = href.match(/https?:\\/\\/[^\\s\"'<>]+/i);
      if (m && m[0] && isRemoteHttpHref(m[0])) return m[0];
      var u = new URL(href, location.origin);
      var blob = (u.pathname || '') + (u.search || '') + (u.hash || '');
      m = blob.match(/https?:\\/\\/[^\\s\"'<>]+/i);
      if (m && m[0] && isRemoteHttpHref(m[0])) return m[0];
      var parts = blob.split('/');
      for (var i = parts.length - 1; i >= 0; i--) {
        var p = parts[i];
        if (!p) continue;
        try {
          var dec = decodeURIComponent(p);
          if (/^https?:\\/\\//i.test(dec) && isRemoteHttpHref(dec)) return dec;
        } catch (e2) {}
      }
    } catch (e) {}
    return '';
  }
  function remoteFromHref(href) {
    if (!href) return '';
    var d = decodeScramjetUrl(href) || decodeUvEncodedUrl(href) || decodeEmbeddedHttpUrl(href);
    if (d) return d;
    try {
      var u = new URL(href);
      var h = u.hostname.toLowerCase();
      if (
        (u.protocol === 'http:' || u.protocol === 'https:') &&
        h !== 'localhost' && h !== '127.0.0.1' && h !== '::1'
      ) {
        return u.href;
      }
    } catch (e) {}
    return '';
  }
`;

const GUEST_DECODE_HREF_TO_REMOTE = `(function(href) {
  ${GUEST_TUNNEL_DECODE_CORE}
  return remoteFromHref(href);
})`;

const GUEST_RESOLVE_LINK_TO_REMOTE = `(function(linkHref) {
  ${GUEST_TUNNEL_DECODE_CORE}
  function absInDoc(doc, href) {
    try {
      var a = doc.createElement('a');
      a.href = href;
      return a.href;
    } catch (e) { return ''; }
  }
  function fromFrame(f) {
    if (!f) return '';
    try {
      var doc = f.contentDocument;
      if (!doc && f.contentWindow) doc = f.contentWindow.document;
      if (!doc) return '';
      return remoteFromHref(absInDoc(doc, linkHref));
    } catch (e) {}
    return '';
  }
  try {
    var absPage = new URL(linkHref, location.href).href;
    var fromPage = remoteFromHref(absPage);
    if (fromPage) return fromPage;
  } catch (e) {}
  return (
    remoteFromHref(linkHref) ||
    fromFrame(document.getElementById('sj-frame')) ||
    fromFrame(document.getElementById('uv-frame')) ||
    ''
  );
})`;

/** Find anchor under (x,y) in proxy shell + inner frames; return decoded remote URL. */
const GUEST_PICK_LINK_REMOTE_AT_POINT = `(function(x, y) {
  ${GUEST_TUNNEL_DECODE_CORE}
  function hrefFromEl(el) {
    if (!el) return '';
    var a = null;
    try {
      a = el.closest ? el.closest('a[href]') : null;
    } catch (e) {}
    if (!a && el.tagName === 'A') a = el;
    if (!a || !a.getAttribute('href')) return '';
    return a.href || '';
  }
  function pickDoc(doc, px, py) {
    if (!doc || !doc.elementFromPoint) return '';
    var el = doc.elementFromPoint(px, py);
    if (!el) return '';
    if (el.tagName === 'IFRAME') {
      var nested = pickFrame(el, px, py);
      if (nested) return nested;
    }
    var href = hrefFromEl(el);
    if (href) return remoteFromHref(href) || '';
    return '';
  }
  function pickFrame(frame, px, py) {
    if (!frame) return '';
    var rect = frame.getBoundingClientRect();
    var fx = px - rect.left;
    var fy = py - rect.top;
    if (fx < 0 || fy < 0 || fx >= rect.width || fy >= rect.height) return '';
    try {
      var doc = frame.contentDocument;
      if (!doc && frame.contentWindow) doc = frame.contentWindow.document;
      if (!doc) return '';
      return pickDoc(doc, fx, fy);
    } catch (e) {}
    return '';
  }
  var shellHit = pickDoc(document, x, y);
  if (shellHit) return shellHit;
  var sj = document.getElementById('sj-frame');
  if (sj) {
    var sjHit = pickFrame(sj, x, y);
    if (sjHit) return sjHit;
  }
  var uv = document.getElementById('uv-frame');
  if (uv) {
    var uvHit = pickFrame(uv, x, y);
    if (uvHit) return uvHit;
  }
  return '';
})`;

let currentProxyProcess = null;
/** Active Electron download items (in progress or awaiting save dialog). */
const activeDownloadItems = new Set();
let quitConfirmed = false;
let quitWhenDownloadsComplete = false;
let quitPromptWin = null;
let pendingQuitPromptResolve = null;
let quitPromptPromise = null;
let confirmPromptWin = null;
let pendingConfirmPromptResolve = null;
let confirmPromptPromise = null;
let confirmPromptGeneration = 0;
let downloadProgressBroadcastTimer = null;
/** Port the spawned proxy child was started on (null if not running). */
let currentProxyListenPort = null;
/** @type {'ultraviolet' | 'scramjet' | null} */
let currentProxyKind = null;
/** One-shot notice when the configured proxy port was unavailable at app startup. */
let proxyPortStartupRelocateNotified = false;
let pendingBavariumLaunchUrl = null;

const NODE = process.execPath;

/** macOS ShareMenu + Windows WinRT share sheet (optional native addon). */
const nativeShare = (() => {
  try {
    return require('electron-native-share');
  } catch {
    return null;
  }
})();

/** Filesystem root that contains `ultraviolet-app` / `scramjet-app` (outside asar when packaged). */
function appResourceRoot() {
  if (!app.isPackaged) {
    return __dirname;
  }
  const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked');
  const probe = path.join(unpacked, 'ultraviolet-app', 'package.json');
  if (fs.existsSync(probe)) {
    return unpacked;
  }
  const besideAsar = path.join(path.dirname(app.getAppPath()), 'app.asar.unpacked');
  if (fs.existsSync(path.join(besideAsar, 'ultraviolet-app', 'package.json'))) {
    return besideAsar;
  }
  return unpacked;
}

/** PNG used for window / taskbar icon (dev) and by electron-builder for installers. */
function getAppIconPath() {
  const p = path.join(__dirname, 'build', 'icon.png');
  return fs.existsSync(p) ? p : null;
}

/** Windows/Linux: hide File/Edit/View menu bar until Alt is held down. */
function setupHoldAltMenuBar(win) {
  if (process.platform === 'darwin') {
    return;
  }

  win.setAutoHideMenuBar(false);
  win.setMenuBarVisibility(false);

  const showBar = () => {
    if (!win.isDestroyed()) {
      win.setMenuBarVisibility(true);
    }
  };
  const hideBar = () => {
    if (!win.isDestroyed()) {
      win.setMenuBarVisibility(false);
    }
  };

  const isAltKey = (input) =>
    input.key === 'Alt' || input.code === 'AltLeft' || input.code === 'AltRight';

  win.webContents.on('before-input-event', (_event, input) => {
    if (isAltKey(input)) {
      if (input.type === 'keyDown') {
        showBar();
      }
      else if (input.type === 'keyUp') {
        hideBar();
      }
      return;
    }
    if (input.type === 'keyDown' && input.alt) {
      showBar();
    }
    else if (input.type === 'keyUp' && !input.alt) {
      hideBar();
    }
  });

  win.on('blur', hideBar);
}

function getActiveDownloadCount() {
  let n = 0;
  for (const item of activeDownloadItems) {
    try {
      if (item && typeof item.getState === 'function') {
        const state = item.getState();
        if (state !== 'completed' && state !== 'cancelled') n++;
      } else {
        n++;
      }
    } catch (_) {
      n++;
    }
  }
  return n;
}

function scheduleDownloadProgressBroadcast() {
  if (downloadProgressBroadcastTimer) return;
  downloadProgressBroadcastTimer = setTimeout(() => {
    downloadProgressBroadcastTimer = null;
    if (getActiveDownloadCount() > 0) {
      broadcastToAllWindows('downloads-updated');
    }
  }, 300);
}

function summarizeActiveDownloadItem(item) {
  if (!item) return null;
  try {
    const state = item.getState();
    if (state === 'completed' || state === 'cancelled') return null;
    const received = item.getReceivedBytes();
    const total = item.getTotalBytes();
    return {
      id: `active-${item.getStartTime ? item.getStartTime() : Date.now()}`,
      name: item.getFilename() || 'Download',
      path: item.getSavePath() || '',
      url: item.getURL() || '',
      state,
      receivedBytes: Number.isFinite(received) ? received : 0,
      totalBytes: Number.isFinite(total) ? total : 0,
      active: true,
      ts: Date.now(),
    };
  } catch (_) {
    return null;
  }
}

function trackActiveDownloadItem(item) {
  if (!item) return;
  activeDownloadItems.add(item);
  item.on('updated', scheduleDownloadProgressBroadcast);
  const untrack = () => {
    activeDownloadItems.delete(item);
    scheduleDownloadProgressBroadcast();
    if (quitWhenDownloadsComplete && getActiveDownloadCount() === 0) {
      quitWhenDownloadsComplete = false;
      quitConfirmed = true;
      app.quit();
    }
  };
  item.once('done', untrack);
}

function cancelActiveDownloads() {
  for (const item of activeDownloadItems) {
    try {
      if (item && typeof item.cancel === 'function') item.cancel();
    } catch (_) {}
  }
  activeDownloadItems.clear();
}

function showQuitPrompt() {
  return new Promise((resolve) => {
    if (quitPromptWin && !quitPromptWin.isDestroyed()) {
      try {
        quitPromptWin.close();
      } catch (_) {}
    }
    pendingQuitPromptResolve = resolve;
    const parent = dialogParentWindow();
    const iconPath = getAppIconPath();
    const activeDownloads = getActiveDownloadCount();
    const height = activeDownloads > 0 ? 300 : 200;
    quitPromptWin = new BrowserWindow({
      width: 460,
      height,
      minWidth: 380,
      minHeight: height,
      maxHeight: 360,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: !!(parent && !parent.isDestroyed()),
      show: false,
      autoHideMenuBar: true,
      title: 'Quit Bavarium',
      ...(iconPath ? { icon: iconPath } : {}),
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
      },
    });
    quitPromptWin.on('closed', () => {
      quitPromptWin = null;
      if (pendingQuitPromptResolve) {
        const done = pendingQuitPromptResolve;
        pendingQuitPromptResolve = null;
        done({ proceed: false });
      }
    });
    quitPromptWin.loadFile(path.join(__dirname, 'quit-prompt.html'));
    quitPromptWin.webContents.once('did-finish-load', () => {
      if (!quitPromptWin || quitPromptWin.isDestroyed()) return;
      quitPromptWin.webContents.send('quit-prompt-init', { activeDownloads });
      quitPromptWin.show();
      quitPromptWin.focus();
    });
  });
}

/**
 * @returns {Promise<{ proceed: boolean, downloadInBackground?: boolean }>}
 */
function requestQuitConfirmation() {
  if (quitPromptPromise) return quitPromptPromise;
  quitPromptPromise = showQuitPrompt().finally(() => {
    quitPromptPromise = null;
  });
  return quitPromptPromise;
}

function showConfirmPrompt(payload) {
  if (confirmPromptPromise) return confirmPromptPromise;
  confirmPromptPromise = new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      confirmPromptPromise = null;
      resolve(result);
    };
    const generation = ++confirmPromptGeneration;
    if (confirmPromptWin && !confirmPromptWin.isDestroyed()) {
      try {
        confirmPromptWin.close();
      } catch (_) {}
      confirmPromptWin = null;
    }
    pendingConfirmPromptResolve = finish;
    const parent = dialogParentWindow();
    const iconPath = getAppIconPath();
    const title =
      (payload && payload.windowTitle) || 'Confirm';
    const message =
      (payload && payload.message) || 'Are you sure you want to continue?';
    const lineCount = Math.ceil(message.length / 52);
    const height = Math.min(320, Math.max(180, 120 + lineCount * 18));
    confirmPromptWin = new BrowserWindow({
      width: 480,
      height,
      minWidth: 360,
      minHeight: height,
      maxHeight: 400,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: !!(parent && !parent.isDestroyed()),
      show: false,
      autoHideMenuBar: true,
      title,
      ...(iconPath ? { icon: iconPath } : {}),
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
      },
    });
    confirmPromptWin.on('closed', () => {
      confirmPromptWin = null;
      if (
        pendingConfirmPromptResolve === finish &&
        generation === confirmPromptGeneration
      ) {
        pendingConfirmPromptResolve = null;
        finish({ proceed: false });
      }
    });
    confirmPromptWin.loadFile(path.join(__dirname, 'confirm-prompt.html'));
    confirmPromptWin.webContents.once('did-finish-load', () => {
      if (!confirmPromptWin || confirmPromptWin.isDestroyed()) return;
      confirmPromptWin.webContents.send('confirm-prompt-init', {
        windowTitle: title,
        message,
        confirmLabel: (payload && payload.confirmLabel) || 'Continue',
      });
      confirmPromptWin.show();
      confirmPromptWin.focus();
    });
  });
  return confirmPromptPromise;
}

function destroyAllBrowserWindows() {
  for (const w of getAppBrowserWindows()) {
    try {
      if (!w.isDestroyed()) w.destroy();
    } catch (_) {}
  }
}

async function finalizeQuitFromPrompt({ downloadInBackground }) {
  const activeCount = getActiveDownloadCount();
  if (downloadInBackground && activeCount > 0) {
    quitWhenDownloadsComplete = true;
    destroyAllBrowserWindows();
    return;
  }
  cancelActiveDownloads();
  quitConfirmed = true;
  app.quit();
}

function attachWindowQuitGuard(win) {
  win.on('close', (e) => {
    if (quitConfirmed || quitWhenDownloadsComplete) return;
    const others = getAppBrowserWindows().filter((w) => w !== win);
    if (others.length > 0) return;

    e.preventDefault();
    void requestQuitConfirmation().then((result) => {
      if (!result || !result.proceed) return;
      void finalizeQuitFromPrompt({
        downloadInBackground: !!result.downloadInBackground,
      });
    });
  });
}

function createWindow() {
  const iconPath = getAppIconPath();
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      webviewTag: true,
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    }
  });

  attachWindowQuitGuard(win);
  setupHoldAltMenuBar(win);
  win.webContents.once('did-finish-load', () => {
    sendProxyStartupStateToWindow(win);
    if (pendingBavariumLaunchUrl) {
      dispatchBavariumProtocolUrl(pendingBavariumLaunchUrl);
      pendingBavariumLaunchUrl = null;
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  return win;
}

/**
 * Application menu with visible keyboard shortcuts (especially on macOS).
 * Actions are handled in renderer.js via `bavarium-menu-action`.
 */
function createApplicationMenu() {
  const isMac = process.platform === 'darwin';

  const send = (action) => {
    const win = BrowserWindow.getFocusedWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('bavarium-menu-action', action);
    }
  };

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  const fileSubmenu = [
    { label: 'New Window', accelerator: 'CommandOrControl+N', click: () => createWindow() },
    { label: 'New Tab', accelerator: 'CommandOrControl+T', click: () => send('new-tab') },
    {
      label: 'New Incognito Tab',
      accelerator: 'CommandOrControl+Shift+N',
      click: () => send('incognito-tab')
    },
    { type: 'separator' },
    {
      label: 'Bookmark This Page…',
      accelerator: 'CommandOrControl+D',
      click: () => send('bookmark-page')
    },
    { label: 'Close Tab', accelerator: 'CommandOrControl+W', click: () => send('close-tab') },
    { type: 'separator' },
    { label: 'Focus Address Bar', accelerator: 'CommandOrControl+L', click: () => send('focus-url') }
  ];
  if (!isMac) {
    fileSubmenu.push({ type: 'separator' }, { role: 'quit' });
  }
  template.push({ label: 'File', submenu: fileSubmenu });

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? [{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }]
        : [{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }]),
      { type: 'separator' },
      { label: 'Find…', accelerator: 'CommandOrControl+F', click: () => send('find-in-page') }
    ]
  });

  template.push({
    label: 'View',
    submenu: [
      {
        label: 'Reload Page',
        accelerator: 'CommandOrControl+R',
        click: () => send('reload')
      },
      { type: 'separator' },
      {
        label: 'Zoom In',
        accelerator: 'CommandOrControl+=',
        click: () => send('zoom-in')
      },
      {
        label: 'Zoom Out',
        accelerator: 'CommandOrControl+-',
        click: () => send('zoom-out')
      },
      {
        label: 'Reset Zoom',
        accelerator: 'CommandOrControl+0',
        click: () => send('zoom-reset')
      },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  });

  const tabSubmenu = [];
  for (let i = 1; i <= 8; i++) {
    tabSubmenu.push({
      label: `Select Tab ${i}`,
      accelerator: `CommandOrControl+${i}`,
      click: () => send(`tab-${i}`)
    });
  }
  tabSubmenu.push({
    label: 'Select Last Tab',
    accelerator: 'CommandOrControl+9',
    click: () => send('tab-9')
  });
  template.push({ label: 'Tab', submenu: tabSubmenu });

  template.push({
    label: 'Browser',
    submenu: [
      { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => send('settings') },
      { type: 'separator' },
      { label: 'Proxy Configuration', click: () => send('proxy') },
      { label: 'Browsing/Searching', click: () => send('browsing') },
      { label: 'History/Privacy', click: () => send('history') },
      { label: 'Developer', click: () => send('developer') },
      {
        label: 'Download Manager',
        accelerator: 'CommandOrControl+Alt+L',
        click: () => send('downloads')
      }
    ]
  });

  if (isMac) {
    template.push({
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
        { type: 'separator' },
        {
          label: 'Close Window',
          accelerator: 'CommandOrControl+Shift+W',
          click: () => {
            const w = BrowserWindow.getFocusedWindow();
            if (w && !w.isDestroyed()) w.close();
          }
        }
      ]
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function startProxy(type, port) {
  if (type !== 'ultraviolet' && type !== 'scramjet') {
    return null;
  }
  const dir = type === 'ultraviolet' ? 'ultraviolet-app' : 'scramjet-app';
  const cwd = path.join(appResourceRoot(), dir);
  const entry = path.join(cwd, 'src', 'index.js');

  if (!fs.existsSync(entry)) {
    if (app.isPackaged) {
      dialog.showErrorBox(
        'Bavarium',
        `The local proxy could not be started (missing files):\n${entry}`
      );
    }
    return null;
  }

  const child = spawn(NODE, [entry], {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
    },
  });

  child.on('error', (err) => {
    console.error(`Proxy (${type}) spawn error:`, err);
  });

  return child;
}

function stopProxy() {
  if (currentProxyProcess) {
    console.log('Stopping proxy...');
    currentProxyProcess.kill();
    currentProxyProcess = null;
  }
  currentProxyListenPort = null;
  currentProxyKind = null;
}

function proxyChildIsRunning() {
  return !!(currentProxyProcess && currentProxyProcess.exitCode == null);
}

function getProxyStartupState() {
  const settings = mergedSettingsFromDisk();
  if (settings.proxyEnabled === false) {
    return {
      proxyEnabled: false,
      status: 'disabled',
      ready: true,
      message: 'Proxy is disabled.',
    };
  }
  const proxyType = normalizeProxyTypeFromDisk(settings.proxyType || 'ultraviolet');
  const label = proxyType === 'scramjet' ? 'Scramjet' : 'Ultraviolet';
  if (proxyChildIsRunning() && currentProxyListenPort != null) {
    return {
      proxyEnabled: true,
      status: 'running',
      ready: true,
      proxyType,
      port: currentProxyListenPort,
      message: `${label} proxy is ready.`,
    };
  }
  return {
    proxyEnabled: true,
    status: 'starting',
    ready: false,
    proxyType,
    message: `Starting ${label} proxy…`,
  };
}

function sendProxyStartupStateToWindow(win) {
  if (!win || win.isDestroyed()) return;
  const state = getProxyStartupState();
  try {
    win.webContents.send('proxy-port-state', {
      status: state.status === 'disabled' ? 'disabled' : state.status,
      proxyType: state.proxyType,
      port: state.port,
      message: state.message,
      ready: state.ready,
      settings: mergedSettingsFromDisk(),
    });
  } catch (_) {}
}

function defaultPortForProxyType(proxyType) {
  return proxyType === 'scramjet' ? 3000 : 8080;
}

/**
 * First free TCP port on 127.0.0.1 starting at preferredPort (up to maxAttempts).
 * @returns {Promise<number | null>}
 */
async function findAvailableListenPort(preferredPort, maxAttempts = 50) {
  const base = parseInt(String(preferredPort), 10);
  if (!Number.isFinite(base) || base < 1 || base > 65535) {
    return null;
  }
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = base + i;
    if (candidate > 65535) break;
    const result = await checkPortInUse(candidate);
    if (!result.inUse) return candidate;
  }
  return null;
}

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function broadcastProxyPortState(payload) {
  const merged = mergedSettingsFromDisk();
  broadcastToAllWindows('proxy-port-state', {
    ...payload,
    settings: merged,
  });
  broadcastToAllWindows('settings-updated', merged);
}

function buildProxyPortStartupRelocateMessage(newPort) {
  return (
    `The port of your proxy was changed to ${newPort} because the previous one you applied was unavailable at startup. If you need the old port, make sure there is no services or apps that are using that port in the background. You can still change the port by going to Settings > Proxy configuration and changing the port for your active proxy.`
  );
}

function maybeNotifyProxyPortStartupRelocate(previousPort, newPort) {
  const prev = parseInt(String(previousPort), 10);
  const next = parseInt(String(newPort), 10);
  if (proxyPortStartupRelocateNotified) return;
  if (!Number.isFinite(prev) || !Number.isFinite(next) || prev === next) return;
  proxyPortStartupRelocateNotified = true;
  const parent = dialogParentWindow();
  dialog.showMessageBox(parent && !parent.isDestroyed() ? parent : undefined, {
    type: 'info',
    buttons: ['OK'],
    defaultId: 0,
    noLink: true,
    title: APP_DISPLAY_NAME,
    message: buildProxyPortStartupRelocateMessage(next),
  });
}

function persistProxyPortInSettings(proxyType, port, options = {}) {
  const { notify = true } = options;
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  let s = {};
  try {
    if (fs.existsSync(settingsPath)) {
      s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch (_) {}
  if (proxyType === 'scramjet') {
    s.scramjetPort = String(port);
  } else {
    s.uvPort = String(port);
  }
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
  } catch (err) {
    console.error('persistProxyPortInSettings:', err);
  }
  if (notify) {
    broadcastProxyPortState({
      status: 'relocated',
      proxyType,
      port,
      message: `Proxy port updated to ${port}.`,
    });
  }
}

function attachProxyExitRecovery(child, proxyType, boundPort, startedAt) {
  child.on('exit', (code, signal) => {
    if (code == null || code === 0) return;
    if (currentProxyProcess !== child) return;
    if (Date.now() - startedAt > 12000) return;

    console.error(`Proxy (${proxyType}) exited with code ${code}`, signal || '');
    currentProxyProcess = null;
    currentProxyListenPort = null;
    currentProxyKind = null;

    void (async () => {
      await delayMs(450);
      const nextPort = await findAvailableListenPort(boundPort + 1, 40);
      if (nextPort == null) {
        broadcastProxyPortState({
          status: 'failed',
          proxyType,
          port: boundPort,
          message: `Port ${boundPort} is in use and no nearby port was free.`,
        });
        return;
      }
      console.warn(
        `Retrying ${proxyType} on port ${nextPort} after exit on ${boundPort}.`
      );
      persistProxyPortInSettings(proxyType, nextPort);
      await spawnProxyOnPort(proxyType, nextPort, {
        preferredPort: boundPort,
        allowRetry: false,
      });
    })();
  });
}

/**
 * @returns {Promise<number | null>}
 */
async function spawnProxyOnPort(proxyType, port, options = {}) {
  const { preferredPort = port, allowRetry = true, atStartup = false } = options;
  const child = startProxy(proxyType, port);
  if (!child) {
    broadcastProxyPortState({
      status: 'failed',
      proxyType,
      port,
      message: 'Could not start the proxy process.',
    });
    return null;
  }

  currentProxyProcess = child;
  currentProxyListenPort = port;
  currentProxyKind = proxyType;

  const startedAt = Date.now();
  if (allowRetry) {
    attachProxyExitRecovery(child, proxyType, port, startedAt);
  }

  const listening = await waitForPortOpen(port, 6000);
  if (!listening) {
    console.warn(`Proxy (${proxyType}) did not open port ${port} in time.`);
    if (allowRetry) {
      try {
        child.kill();
      } catch (_) {}
      currentProxyProcess = null;
      currentProxyListenPort = null;
      currentProxyKind = null;
      await delayMs(450);
      const nextPort = await findAvailableListenPort(port + 1, 40);
      if (nextPort != null && nextPort !== port) {
        persistProxyPortInSettings(proxyType, nextPort);
        return spawnProxyOnPort(proxyType, nextPort, {
          preferredPort,
          allowRetry: false,
          atStartup,
        });
      }
    }
    broadcastProxyPortState({
      status: 'failed',
      proxyType,
      port,
      message: `Nothing is listening on port ${port}.`,
    });
    return null;
  }

  const preferred = parseInt(String(preferredPort), 10);
  if (port !== preferred) {
    if (atStartup) {
      maybeNotifyProxyPortStartupRelocate(preferred, port);
    }
    broadcastProxyPortState({
      status: 'relocated',
      proxyType,
      port,
      previousPort: Number.isFinite(preferred) ? preferred : preferredPort,
      startupRelocated: atStartup === true,
      message: `Port ${preferredPort} was in use; proxy is running on ${port}.`,
      ready: true,
    });
  } else {
    broadcastProxyPortState({
      status: 'running',
      proxyType,
      port,
      message: `Proxy listening on port ${port}.`,
      ready: true,
    });
  }

  await clearProxyShellStorageForPort(port);

  return port;
}

/**
 * Pick a listen port (configured or next free) and spawn the proxy child.
 * @returns {Promise<number | null>}
 */
async function startProxyWithResolvedPort(proxyType, preferredPort, options = {}) {
  if (proxyType !== 'ultraviolet' && proxyType !== 'scramjet') {
    return null;
  }

  const { atStartup = false } = options;
  const preferred = parseInt(String(preferredPort), 10);
  const fallback = defaultPortForProxyType(proxyType);
  const startFrom = Number.isFinite(preferred) ? preferred : fallback;

  let port = await findAvailableListenPort(startFrom);
  if (port == null) {
    dialog.showErrorBox(
      APP_DISPLAY_NAME,
      `Could not find a free port near ${startFrom} for the ${proxyType === 'scramjet' ? 'Scramjet' : 'Ultraviolet'} proxy.\n\n` +
        'Another app may be using many ports, or a previous Bavarium session may still be running. Quit other copies of Bavarium or change the port in Settings → Proxy.'
    );
    broadcastProxyPortState({
      status: 'failed',
      proxyType,
      port: startFrom,
      message: `No free port found near ${startFrom}.`,
    });
    return null;
  }

  if (port !== startFrom) {
    console.warn(
      `Proxy port ${startFrom} is in use; starting ${proxyType} on ${port} instead.`
    );
    persistProxyPortInSettings(proxyType, port);
  }

  return spawnProxyOnPort(proxyType, port, { preferredPort: startFrom, atStartup });
}

function waitForPort(port, callback) {
  waitForPortOpen(port, 120000).then((ok) => {
    if (ok) callback();
  });
}

/** @returns {Promise<boolean>} */
function waitForPortOpen(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      if (Date.now() > deadline) {
        resolve(false);
        return;
      }
      const client = new net.Socket();
      client.setTimeout(600);
      client.once('connect', () => {
        client.end();
        resolve(true);
      });
      client.once('timeout', () => {
        client.destroy();
        setTimeout(attempt, 280);
      });
      client.once('error', () => {
        client.destroy();
        setTimeout(attempt, 280);
      });
      client.connect(port, '127.0.0.1');
    };
    attempt();
  });
}

function loadSettings() {
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath));
    }
  } catch {}
  return {};
}

function normalizeProxyTypeFromDisk(pt) {
  if (pt === 'frogies') return 'ultraviolet';
  return pt || 'ultraviolet';
}

function normalizeHomepageFromDisk(h) {
  if (h === 'frogies') return 'google';
  return h || 'bavarium';
}

function normalizeExternalLinkOpenPreference(raw) {
  if (raw === 'external' || raw === 'bavarium') return raw;
  return 'ask';
}

function normalizeSafeBrowsingProvider(raw) {
  if (raw === 'google' || raw === 'local' || raw === 'both') return raw;
  return 'both';
}

function safeBrowsingOptionsFromSettings(settings) {
  const s = settings || mergedSettingsFromDisk();
  return {
    enabled: s.safeBrowsingEnabled !== false,
    provider: normalizeSafeBrowsingProvider(s.safeBrowsingProvider),
    googleApiKey: String(s.safeBrowsingApiKey || '').trim(),
  };
}

function isBavariumShellFilePageUrl(pageUrl) {
  if (!pageUrl || typeof pageUrl !== 'string') return false;
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== 'file:') return false;
    const p = u.pathname.replace(/\\/g, '/').toLowerCase();
    return p.endsWith('/newtab.html') || p.endsWith('/settings.html');
  } catch {
    return false;
  }
}

function isUnsafeWarningPageUrl(pageUrl) {
  if (!pageUrl || typeof pageUrl !== 'string') return false;
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== 'file:') return false;
    const p = u.pathname.replace(/\\/g, '/').toLowerCase();
    return p.endsWith('/unsafe-warning.html');
  } catch {
    return false;
  }
}

let safeBrowsingService = null;

function getSafeBrowsingService() {
  if (!safeBrowsingService) {
    safeBrowsingService = createSafeBrowsingService({
      userDataPath: app.getPath('userData'),
    });
  }
  return safeBrowsingService;
}

function resolveRemoteUrlForSafeBrowsing(url) {
  const fromSj = decodeScramjetTunnelUrlMenu(url);
  if (fromSj) return fromSj;
  const fromShell = proxyShellTargetFromUrl(url);
  if (fromShell) {
    const remote = coerceRemoteHttpUrl(fromShell);
    if (remote) return remote;
  }
  return coerceRemoteHttpUrl(url);
}

async function checkSafeBrowsingForNavigation(url) {
  const sbOpts = safeBrowsingOptionsFromSettings();
  if (!sbOpts.enabled) return null;
  const remote = resolveRemoteUrlForSafeBrowsing(url);
  if (!remote || !isHttpUrl(remote)) return null;
  const result = await getSafeBrowsingService().checkUrl(remote, sbOpts);
  if (!result.blocked) return null;
  return { ...result, url: remote };
}

function mergedSettingsFromDisk() {
  const s = loadSettings();
  return {
    searchEngine: s.searchEngine || 'google',
    proxyType: normalizeProxyTypeFromDisk(s.proxyType),
    transport: s.transport || 'epoxy',
    wssServer: s.wssServer || '',
    proxyEnabled: s.proxyEnabled !== false,
    uvPort: s.uvPort || '8080',
    scramjetPort: s.scramjetPort || '3000',
    homepage: normalizeHomepageFromDisk(s.homepage),
    historyEnabled: s.historyEnabled !== false,
    safeBrowsingEnabled: s.safeBrowsingEnabled !== false,
    safeBrowsingProvider: normalizeSafeBrowsingProvider(s.safeBrowsingProvider),
    safeBrowsingApiKey: String(s.safeBrowsingApiKey || '').trim(),
    askBeforeDownload: s.askBeforeDownload !== false,
    downloadPath: s.downloadPath || '',
    trackPreReleaseUpdates: s.trackPreReleaseUpdates === true,
    externalLinkOpenPreference: normalizeExternalLinkOpenPreference(
      s.externalLinkOpenPreference
    ),
    enableChromiumDevTools: s.enableChromiumDevTools !== false,
    enablePerformanceGraph: s.enablePerformanceGraph === true,
    fpsLimitEnabled: s.fpsLimitEnabled === true,
    fpsLimit: normalizeFpsLimitValue(s.fpsLimit),
    fpsSyncDisplay: s.fpsSyncDisplay !== false,
    hideBookmarkBarExceptHomepage: s.hideBookmarkBarExceptHomepage === true,
    homepageCustomBackground: String(s.homepageCustomBackground || '').trim(),
    homepageShowTiles: s.homepageShowTiles !== false,
    homepageShowVersionInfo: s.homepageShowVersionInfo !== false,
    homepageShowSystemInfo: s.homepageShowSystemInfo !== false,
    homepageShowProxyPort: s.homepageShowProxyPort !== false,
    showDevToolsOnScreenOverlay: s.showDevToolsOnScreenOverlay === true,
  };
}

const HOMEPAGE_BACKGROUND_BASENAME = 'homepage-background';

function homepageBackgroundFilePath(stored) {
  const key = String(stored || '').trim();
  if (!key) return '';
  if (path.isAbsolute(key)) return key;
  if (key === HOMEPAGE_BACKGROUND_BASENAME) {
    const dir = app.getPath('userData');
    const entries = fs.readdirSync(dir);
    const match = entries.find((name) =>
      name.startsWith(`${HOMEPAGE_BACKGROUND_BASENAME}.`)
    );
    return match ? path.join(dir, match) : '';
  }
  return path.join(app.getPath('userData'), key);
}

function homepageBackgroundFileUrl(stored) {
  const full = homepageBackgroundFilePath(stored);
  if (!full || !fs.existsSync(full)) return '';
  return pathToFileURL(full).href;
}

function getDevToolsShortcutLabel() {
  if (process.platform === 'darwin') return 'Cmd+Option+I';
  return 'Ctrl+Shift+I';
}

function parseGuestConsoleMessageArgs(args) {
  for (const candidate of args) {
    if (
      candidate &&
      typeof candidate === 'object' &&
      typeof candidate.message === 'string'
    ) {
      return {
        level: candidate.level,
        message: candidate.message,
        lineNumber: candidate.lineNumber ?? candidate.line,
        sourceId: candidate.sourceId,
      };
    }
  }
  if (args.length >= 3 && typeof args[2] === 'string') {
    return {
      level: args[1],
      message: args[2],
      lineNumber: args[3],
      sourceId: args[4],
    };
  }
  return null;
}

function guestConsoleSeverity(level) {
  if (typeof level === 'number') {
    if (level >= 3) return 'error';
    if (level >= 2) return 'warn';
    return null;
  }
  const s = String(level || '').toLowerCase();
  if (s === 'error') return 'error';
  if (s === 'warning' || s === 'warn') return 'warn';
  return null;
}

function forwardGuestConsoleMessageToShell(wc, details) {
  if (!details || !details.message) return;
  if (mergedSettingsFromDisk().showDevToolsOnScreenOverlay !== true) return;
  const severity = guestConsoleSeverity(details.level);
  if (!severity) return;
  const host = wc.hostWebContents;
  if (!host || host.isDestroyed()) return;
  let text = String(details.message);
  if (details.lineNumber != null && details.sourceId) {
    const src = String(details.sourceId);
    const shortSrc = src.length > 72 ? `…${src.slice(-68)}` : src;
    text = `${text} (${shortSrc}:${details.lineNumber})`;
  }
  host.send('bavarium-guest-console-message', {
    message: text,
    level: severity,
  });
}

function normalizeFpsLimitValue(raw) {
  const displayHz = getDisplayRefreshRate();
  const n = parseInt(String(raw ?? 60), 10);
  if (!Number.isFinite(n)) return Math.min(60, displayHz);
  return Math.max(1, Math.min(displayHz, n));
}

function getDisplayRefreshRate() {
  try {
    const d = screen.getPrimaryDisplay();
    const hz = d && d.displayFrequency;
    if (Number.isFinite(hz) && hz > 0) return Math.round(hz);
  } catch (_) {}
  return 60;
}

function resolveFrameRateCap(settings) {
  const s = settings || mergedSettingsFromDisk();
  const limitEnabled = s.fpsLimitEnabled === true;
  const syncDisplay = s.fpsSyncDisplay !== false;
  const userLimit = normalizeFpsLimitValue(s.fpsLimit);
  const displayHz = getDisplayRefreshRate();

  if (!limitEnabled) {
    return {
      limitEnabled: false,
      syncDisplay,
      displayHz,
      userLimit,
      cap: null,
      effectiveCap: null,
      vsyncRestartRequired: !syncDisplay,
    };
  }

  const cap = Math.min(userLimit, displayHz);

  return {
    limitEnabled: true,
    syncDisplay,
    displayHz,
    userLimit: cap,
    cap,
    effectiveCap: cap,
    vsyncRestartRequired: !syncDisplay,
  };
}

function applyFrameRateCapToWebContents(wc, cap) {
  if (!wc || wc.isDestroyed() || typeof wc.setFrameRate !== 'function') return;
  try {
    wc.setFrameRate(cap == null ? 240 : cap);
  } catch (e) {
    console.warn('setFrameRate:', e);
  }
}

function buildFrameCapInstallScript(cap) {
  if (cap == null || cap <= 0 || cap >= 240) {
    return `(function(){
      if (window.__bavariumFpsLoopId) {
        clearInterval(window.__bavariumFpsLoopId);
        delete window.__bavariumFpsLoopId;
      }
      if (!window.__bavariumFpsOrigRaf) {
        window.__bavariumFpsOrigRaf = window.requestAnimationFrame.bind(window);
        window.__bavariumFpsOrigCancel = window.cancelAnimationFrame.bind(window);
      }
      var origRaf = window.__bavariumFpsOrigRaf;
      var origCancel = window.__bavariumFpsOrigCancel;
      if (window.__bavariumFpsOrigRaf && window.requestAnimationFrame !== window.__bavariumFpsOrigRaf) {
        window.requestAnimationFrame = window.__bavariumFpsOrigRaf;
        window.cancelAnimationFrame = window.__bavariumFpsOrigCancel;
      }
      if (window.__bavariumFpsPassiveId != null) return;
      window.__bavariumFpsCapInstalled = 0;
      function tick() {
        window.__bavariumFpsCount = (window.__bavariumFpsCount || 0) + 1;
        window.__bavariumFpsPassiveId = origRaf(tick);
      }
      tick();
    })();`;
  }
  const fps = Math.round(cap);
  const intervalMs = Math.max(1, Math.round(1000 / fps));
  return `(function(){
    var cap = ${fps};
    var intervalMs = ${intervalMs};
    if (window.__bavariumFpsCapInstalled === cap) return;
    window.__bavariumFpsCapInstalled = cap;
    if (window.__bavariumFpsLoopId) clearInterval(window.__bavariumFpsLoopId);
    if (!window.__bavariumFpsOrigRaf) {
      window.__bavariumFpsOrigRaf = window.requestAnimationFrame.bind(window);
      window.__bavariumFpsOrigCancel = window.cancelAnimationFrame.bind(window);
    }
    var origRaf = window.__bavariumFpsOrigRaf;
    var origCancel = window.__bavariumFpsOrigCancel;
    if (window.__bavariumFpsPassiveId != null) {
      origCancel(window.__bavariumFpsPassiveId);
      delete window.__bavariumFpsPassiveId;
    }
    var queue = [];
    var nextId = 1;
    window.requestAnimationFrame = function(cb) {
      var id = nextId++;
      queue.push({ id: id, cb: cb });
      return id;
    };
    window.cancelAnimationFrame = function(id) {
      for (var i = 0; i < queue.length; i++) {
        if (queue[i].id === id) { queue.splice(i, 1); return; }
      }
      window.__bavariumFpsOrigCancel(id);
    };
    function pump() {
      origRaf(function(ts) {
        window.__bavariumFpsCount = (window.__bavariumFpsCount || 0) + 1;
        var batch = queue.splice(0, queue.length);
        for (var j = 0; j < batch.length; j++) {
          try { batch[j].cb(ts); } catch (e) {}
        }
      });
    }
    window.__bavariumFpsLoopId = setInterval(pump, intervalMs);
    pump();
  })();`;
}

function injectFrameRateCapOnWebContents(wc) {
  if (!wc || wc.isDestroyed()) return;
  const resolved = resolveFrameRateCap();
  const cap = resolved.limitEnabled ? resolved.effectiveCap : null;
  const script = buildFrameCapInstallScript(cap);
  wc.executeJavaScript(script, true).catch(() => {});
  applyFrameRateCapToWebContents(wc, cap);
}

function injectFrameRateCapOnAllGuests() {
  const resolved = resolveFrameRateCap();
  broadcastToAllWindows('bavarium-frame-rate-settings', resolved);
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    if (wc.getType() === 'webview') {
      injectFrameRateCapOnWebContents(wc);
    } else if (wc.getType() === 'window') {
      applyFrameRateCapToWebContents(
        wc,
        resolved.limitEnabled ? resolved.effectiveCap : null
      );
    }
  }
}

function applyFrameRateSettingsToAll(settings) {
  resolveFrameRateCap(settings);
  injectFrameRateCapOnAllGuests();
}

ipcMain.handle('bavarium-set-guest-zoom', async (_event, payload) => {
  const rawId = payload && payload.webContentsId;
  const id = rawId != null ? Number(rawId) : NaN;
  const factor = payload && payload.factor != null ? Number(payload.factor) : NaN;
  if (!Number.isFinite(id) || !Number.isFinite(factor)) return { ok: false };
  const wc = webContents.fromId(id);
  if (!wc || wc.isDestroyed()) return { ok: false };
  try {
    wc.setZoomFactor(factor);
    return { ok: true, factor };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('bavarium-reset-tab-fps-poll', async (_event, payload) => {
  const rawId = payload && payload.webContentsId;
  const id = rawId != null ? Number(rawId) : NaN;
  if (!Number.isFinite(id)) return { ok: false };
  const wc = webContents.fromId(id);
  if (!wc || wc.isDestroyed()) return { ok: false };
  try {
    await wc.executeJavaScript(
      `(function(){
        delete window.__bavariumFpsLastPoll;
        delete window.__bavariumFpsLastReported;
        window.__bavariumFpsCount = 0;
      })()`,
      true
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('bavarium-poll-tab-fps', async (_event, payload) => {
  const rawId = payload && payload.webContentsId;
  const id = rawId != null ? Number(rawId) : NaN;
  if (!Number.isFinite(id)) return { ok: false, fps: null };
  const wc = webContents.fromId(id);
  if (!wc || wc.isDestroyed()) return { ok: false, fps: null };
  try {
    const displayHz = getDisplayRefreshRate();
    const resolved = resolveFrameRateCap();
    const reportCap =
      resolved.limitEnabled && resolved.effectiveCap
        ? Math.min(resolved.effectiveCap, displayHz)
        : displayHz;
    const result = await wc.executeJavaScript(
      `(function(){
        var n = window.__bavariumFpsCount || 0;
        window.__bavariumFpsCount = 0;
        var now = performance.now();
        var last = window.__bavariumFpsLastPoll;
        window.__bavariumFpsLastPoll = now;
        var pageCap = window.__bavariumFpsCapInstalled || 0;
        var maxFps = ${reportCap};
        if (pageCap > 0 && pageCap < maxFps) maxFps = pageCap;
        function clampFps(v) {
          if (v == null || !isFinite(v) || v <= 0) return null;
          return v > maxFps ? maxFps : v;
        }
        if (last == null || last === undefined) {
          return { fps: null, cap: pageCap };
        }
        var dt = (now - last) / 1000;
        if (dt < 0.05) {
          return {
            fps: clampFps(window.__bavariumFpsLastReported),
            cap: pageCap
          };
        }
        if (dt > 2) {
          return { fps: null, cap: pageCap };
        }
        var fps = Math.round(n / dt);
        if (n === 0 && dt > 1.5) {
          return { fps: null, cap: pageCap };
        }
        fps = clampFps(fps);
        if (fps == null) {
          var prev = clampFps(window.__bavariumFpsLastReported);
          return { fps: prev, cap: pageCap };
        }
        window.__bavariumFpsLastReported = fps;
        return { fps: fps, cap: pageCap };
      })()`,
      true
    );
    return {
      ok: true,
      fps: result.fps != null ? result.fps : null,
      cap: result.cap,
    };
  } catch (e) {
    return { ok: false, fps: null, error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('bavarium-inject-frame-cap', (_event, payload) => {
  const rawId = payload && payload.webContentsId;
  const id = rawId != null ? Number(rawId) : NaN;
  if (!Number.isFinite(id)) return { ok: false };
  const wc = webContents.fromId(id);
  if (!wc || wc.isDestroyed()) return { ok: false };
  injectFrameRateCapOnWebContents(wc);
  return { ok: true };
});

function chromiumDevToolsEnabled() {
  return mergedSettingsFromDisk().enableChromiumDevTools !== false;
}

const netPerfCounters = {
  downBytesWindow: 0,
  upBytesWindow: 0,
  downRateBps: 0,
  upRateBps: 0,
  lastTick: Date.now(),
};

function tickNetPerfRates() {
  const now = Date.now();
  const dt = Math.max(0.001, (now - netPerfCounters.lastTick) / 1000);
  netPerfCounters.downRateBps = netPerfCounters.downBytesWindow / dt;
  netPerfCounters.upRateBps = netPerfCounters.upBytesWindow / dt;
  netPerfCounters.downBytesWindow = 0;
  netPerfCounters.upBytesWindow = 0;
  netPerfCounters.lastTick = now;
}

function setupNetworkPerfCounters(ses) {
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      if (details.uploadData) {
        for (const part of details.uploadData) {
          if (part.bytes && part.bytes.length) {
            netPerfCounters.upBytesWindow += part.bytes.length;
          } else if (part.file) {
            try {
              const st = fs.statSync(part.file);
              netPerfCounters.upBytesWindow += st.size || 0;
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
    callback({ cancel: false });
  });
  ses.webRequest.onHeadersReceived((details, callback) => {
    try {
      const headers = details.responseHeaders || {};
      const cl =
        headers['content-length']?.[0] ||
        headers['Content-Length']?.[0];
      if (cl) {
        const n = parseInt(cl, 10);
        if (Number.isFinite(n) && n > 0) netPerfCounters.downBytesWindow += n;
      }
    } catch (_) {}
    if (typeof callback === 'function') callback({});
  });
}

function readInstalledPackageVersion(pkgName, cwd) {
  try {
    const p = path.join(cwd || __dirname, 'node_modules', pkgName, 'package.json');
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      return j.version || null;
    }
  } catch (_) {}
  return null;
}

function readJsonPackageVersion(pkgPath) {
  try {
    if (fs.existsSync(pkgPath)) {
      const j = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return {
        name: j.name || path.basename(path.dirname(pkgPath)),
        version: j.version || '—',
        displayVersion: j.bavariumDisplayVersion || null,
      };
    }
  } catch (_) {}
  return null;
}

function runNpmJson(args, cwd) {
  return new Promise((resolve) => {
    const workDir = path.resolve(cwd || __dirname);
    const child = spawn('npm', args, {
      cwd: workDir,
      shell: true,
      windowsHide: true,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {}
      resolve({ ok: false, error: 'npm command timed out' });
    }, 120000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      const msg = err && err.message ? err.message : String(err);
      if (err && err.code === 'ENOENT') {
        resolve({
          ok: false,
          error: 'npm was not found. Install Node.js/npm and ensure npm is on your PATH.',
        });
        return;
      }
      resolve({ ok: false, error: msg });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = stdout.trim();
      if (!out) {
        if (code === 0) {
          resolve({ ok: true, data: {}, exitCode: code });
          return;
        }
        resolve({
          ok: false,
          error: stderr.trim() || `npm exited with code ${code}`,
          exitCode: code,
        });
        return;
      }
      try {
        resolve({
          ok: true,
          data: JSON.parse(out),
          exitCode: code,
          stderr: stderr.trim() || undefined,
        });
      } catch (e) {
        resolve({
          ok: false,
          error: e.message || String(e),
          raw: out,
          stderr: stderr.trim() || undefined,
          exitCode: code,
        });
      }
    });
  });
}

function collectFrameworkVersions() {
  const rootPkg = readJsonPackageVersion(path.join(__dirname, 'package.json'));
  const uvPkg = readJsonPackageVersion(path.join(__dirname, 'ultraviolet-app', 'package.json'));
  const sjPkg = readJsonPackageVersion(path.join(__dirname, 'scramjet-app', 'package.json'));
  const rows = [];

  if (rootPkg) {
    rows.push({
      name: 'Bavarium Browser',
      version: rootPkg.displayVersion || rootPkg.version,
      detail: rootPkg.version,
    });
  }

  rows.push(
    { name: 'Electron', version: process.versions.electron || '—' },
    { name: 'Chromium', version: process.versions.chrome || '—' },
    { name: 'Node.js', version: process.versions.node || '—' },
    { name: 'V8', version: process.versions.v8 || '—' }
  );

  try {
    const { execSync } = require('child_process');
    const npmVer = execSync('npm -v', {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      shell: true,
    }).trim();
    if (npmVer) rows.push({ name: 'npm', version: npmVer });
  } catch (_) {}

  const electronInstalled = readInstalledPackageVersion('electron', __dirname);
  if (electronInstalled) {
    rows.push({ name: 'electron (installed)', version: electronInstalled });
  }
  const builderInstalled = readInstalledPackageVersion('electron-builder', __dirname);
  if (builderInstalled) {
    rows.push({ name: 'electron-builder (installed)', version: builderInstalled });
  }
  const shareInstalled = readInstalledPackageVersion('electron-native-share', __dirname);
  if (shareInstalled) {
    rows.push({ name: 'electron-native-share (installed)', version: shareInstalled });
  }
  const rceditInstalled = readInstalledPackageVersion('rcedit', __dirname);
  if (rceditInstalled) {
    rows.push({ name: 'rcedit (installed)', version: rceditInstalled });
  }

  if (uvPkg) rows.push({ name: 'Ultraviolet app', version: uvPkg.version });
  if (sjPkg) rows.push({ name: 'Scramjet app', version: sjPkg.version });

  return { rows, runtime: process.versions };
}

function parseLocalhostPortMenu(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
      return null;
    }
    const port = u.port
      ? parseInt(u.port, 10)
      : u.protocol === 'https:'
        ? 443
        : 80;
    if (!Number.isFinite(port)) return null;
    return { port, pathname: u.pathname || '/' };
  } catch {
    return null;
  }
}

function settingsFileToBavariumDisplayMenu(fileUrl) {
  try {
    const u = new URL(fileUrl);
    if (u.pathname.endsWith('newtab.html')) return 'bavarium://newtab';
    if (!u.pathname.endsWith('settings.html')) return null;
    const h = (u.hash || '').replace(/^#/, '') || 'settings';
    const map = {
      settings: 'bavarium://settings',
      proxy: 'bavarium://proxy',
      browsing: 'bavarium://browsing',
      history: 'bavarium://history',
      privacy: 'bavarium://privacy',
      downloads: 'bavarium://downloads',
      about: 'bavarium://about',
      developer: 'bavarium://developer',
      licenses: 'bavarium://licenses',
      'licenses-scramjet': 'bavarium://licenses/scramjet',
      'licenses-ultraviolet': 'bavarium://licenses/ultraviolet',
    };
    return map[h] || 'bavarium://settings';
  } catch {
    return null;
  }
}

function cleanUrlForContextMenu(url) {
  const pretty = settingsFileToBavariumDisplayMenu(url);
  if (pretty) return pretty;
  const disk = mergedSettingsFromDisk();
  try {
    const u = new URL(url);
    if (
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1') &&
      u.searchParams.has('url')
    ) {
      return decodeURIComponent(u.searchParams.get('url'));
    }
  } catch {}
  return url;
}

function activeProxyPortFromSettings(settings) {
  if (!settings || settings.proxyEnabled === false) return null;
  if (settings.proxyType !== 'ultraviolet' && settings.proxyType !== 'scramjet') {
    return null;
  }
  return settings.proxyType === 'ultraviolet'
    ? parseInt(String(settings.uvPort ?? 8080), 10)
    : parseInt(String(settings.scramjetPort ?? 3000), 10);
}

function isOnActiveProxyOrigin(url, settings) {
  const expected = activeProxyPortFromSettings(settings);
  if (expected === null) return false;
  const loc = parseLocalhostPortMenu(url);
  return !!(loc && loc.port === expected);
}

function guestUrlIsProxyTunnelMenu(url, settings) {
  if (!url || !settings || settings.proxyEnabled === false) return false;
  if (!isOnActiveProxyOrigin(url, settings)) return false;
  try {
    const u = new URL(url);
    if (u.searchParams.has('url')) return true;
    if (settings.proxyType === 'scramjet' && /\/scramjet\//i.test(u.pathname)) {
      return true;
    }
    if (settings.proxyType === 'ultraviolet' && /\/uv\//i.test(u.pathname)) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function isRemoteHttpUrlForMenu(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    if (!/^https?:$/i.test(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function resolveContextMenuLinkUrl(linkURL, baseUrl) {
  if (!linkURL || typeof linkURL !== 'string') return '';
  if (linkURL.startsWith('javascript:') || linkURL.startsWith('data:')) {
    return '';
  }
  try {
    return new URL(linkURL, baseUrl || 'http://localhost/').href;
  } catch {
    return linkURL;
  }
}

function canCopyProxiedUrlMenu(rawUrl, displayUrl, settings, linkURL) {
  if (activeProxyPortFromSettings(settings) === null) return false;
  if (guestUrlIsProxyTunnelMenu(rawUrl, settings)) return true;
  if (resolveContextMenuLinkUrl(linkURL, rawUrl)) return true;
  if (isRemoteHttpUrlForMenu(displayUrl)) return true;
  if (isOnActiveProxyOrigin(rawUrl, settings)) return true;
  return false;
}

/** Decode `http://localhost:PORT/scramjet/https%3A%2F%2F...` in the main process. */
function decodeScramjetTunnelUrlMenu(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    const path = u.pathname || '';
    const marker = '/scramjet/';
    const idx = path.indexOf(marker);
    if (idx === -1) return '';
    const enc = path.slice(idx + marker.length);
    if (!enc) return '';
    const dec = decodeURIComponent(enc);
    return isRemoteHttpUrlForMenu(dec) ? dec : '';
  } catch (_) {
    return '';
  }
}

const PROXY_LANDING_TITLE_RE =
  /^(scramjet(\s*\|\s*mw)?|ultraviolet(\s*\|\s*sophisticated))/i;

function isProxyLandingTitle(title) {
  if (!title || typeof title !== 'string') return false;
  const t = title.trim();
  if (PROXY_LANDING_TITLE_RE.test(t)) return true;
  if (/^ultraviolet\s*\|/i.test(t)) return true;
  if (/^scramjet(\s*\|)?/i.test(t)) return true;
  return false;
}

function titleLooksLikeProxiedShell(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (/^https?:\/\//i.test(t)) return true;
  if (/%3A%2F%2F/i.test(t)) return true;
  return /localhost|127\.0\.0\.1/i.test(t) && /[?#&]url=/i.test(t);
}

/** Target site encoded in a local proxy shell URL (`?url=` or `#url=`). */
function proxyShellTargetFromUrl(shellUrl) {
  if (!shellUrl || typeof shellUrl !== 'string') return '';
  try {
    const u = new URL(shellUrl);
    if (
      u.hostname !== 'localhost' &&
      u.hostname !== '127.0.0.1' &&
      u.hostname !== '::1'
    ) {
      return '';
    }
    let inner = u.searchParams.get('url');
    if (!inner && u.hash) {
      const h = u.hash.replace(/^#/, '');
      if (h.startsWith('url=')) {
        inner = decodeURIComponent(h.slice(4));
      }
    }
    return inner || '';
  } catch (_) {
    return '';
  }
}

function coerceRemoteHttpUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const t = url.trim();
  if (!t) return '';
  if (isRemoteHttpUrlForMenu(t)) return t;
  try {
    const withProto = t.startsWith('http') ? t : `https://${t}`;
    return isRemoteHttpUrlForMenu(withProto) ? new URL(withProto).href : '';
  } catch (_) {
    return '';
  }
}

/**
 * Resolve proxied shell / tunnel URLs and proxy landing titles for homepage tiles.
 * @returns {{ url: string, title: string, isRemote: boolean }}
 */
function normalizeSiteTileMeta(url, title) {
  let u = String(url || '').trim();
  let t = String(title || '').trim();

  const fromScramjet = decodeScramjetTunnelUrlMenu(u);
  if (fromScramjet) u = fromScramjet;

  const fromShell = proxyShellTargetFromUrl(u);
  if (fromShell) {
    const remote = coerceRemoteHttpUrl(fromShell);
    if (remote) u = remote;
  }

  const remoteUrl = coerceRemoteHttpUrl(u);
  if (remoteUrl) u = remoteUrl;

  if (isProxyLandingTitle(t) || titleLooksLikeProxiedShell(t)) {
    t = '';
  }

  let hostname = '';
  try {
    const parsed = new URL(u.startsWith('http') ? u : `https://${u}`);
    hostname = parsed.hostname.replace(/^www\./i, '');
  } catch (_) {}

  const displayTitle = t || hostname || 'Site';
  return {
    url: u,
    title: displayTitle,
    isRemote: isRemoteHttpUrlForMenu(u),
  };
}

async function decodeTunnelHrefInGuest(wc, href) {
  if (!href || typeof href !== 'string' || !wc || wc.isDestroyed()) return '';
  try {
    const decoded = await wc.executeJavaScript(
      `${GUEST_DECODE_HREF_TO_REMOTE}(${JSON.stringify(href)})`,
      true
    );
    return typeof decoded === 'string' ? decoded.trim() : '';
  } catch (_) {
    return '';
  }
}

async function pickLinkRemoteAtPointInGuest(wc, x, y) {
  if (!wc || wc.isDestroyed()) return '';
  if (!Number.isFinite(x) || !Number.isFinite(y)) return '';
  try {
    const picked = await wc.executeJavaScript(
      `${GUEST_PICK_LINK_REMOTE_AT_POINT}(${x}, ${y})`,
      true
    );
    return typeof picked === 'string' && isRemoteHttpUrlForMenu(picked.trim())
      ? picked.trim()
      : '';
  } catch (_) {
    return '';
  }
}

async function resolveLinkHrefParamForClipboard(wc, linkURL, rawUrl) {
  if (!linkURL || typeof linkURL !== 'string') return '';
  const fromMain = decodeScramjetTunnelUrlMenu(linkURL);
  if (fromMain) return fromMain;
  try {
    const fromGuest = await wc.executeJavaScript(
      `${GUEST_RESOLVE_LINK_TO_REMOTE}(${JSON.stringify(linkURL)})`,
      true
    );
    if (typeof fromGuest === 'string' && isRemoteHttpUrlForMenu(fromGuest.trim())) {
      return fromGuest.trim();
    }
  } catch (_) {
    /* guest may block script */
  }
  const resolved = resolveContextMenuLinkUrl(linkURL, rawUrl);
  if (!resolved) return '';
  if (isRemoteHttpUrlForMenu(resolved)) return resolved;
  const decoded = await decodeTunnelHrefInGuest(wc, resolved);
  if (decoded && isRemoteHttpUrlForMenu(decoded)) return decoded;
  return '';
}

/** Link under cursor (iframe-aware); empty if the click was not on a link. */
async function resolveContextMenuLinkTarget(wc, rawUrl, params) {
  if (!wc || wc.isDestroyed()) return '';
  if (params.linkURL) {
    const fromParam = await resolveLinkHrefParamForClipboard(
      wc,
      params.linkURL,
      rawUrl
    );
    if (fromParam) return fromParam;
  }
  const picked = await pickLinkRemoteAtPointInGuest(wc, params.x, params.y);
  if (picked) return picked;
  return '';
}

async function resolvePageRemoteUrlForClipboard(wc, rawUrl, settings) {
  try {
    const u = new URL(rawUrl);
    if (
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1') &&
      u.searchParams.has('url')
    ) {
      const inner = decodeURIComponent(u.searchParams.get('url'));
      if (isRemoteHttpUrlForMenu(inner)) return inner;
    }
  } catch (_) {
    /* ignore */
  }

  if (guestUrlIsProxyTunnelMenu(rawUrl, settings) && wc && !wc.isDestroyed()) {
    const fromTunnel = await decodeTunnelHrefInGuest(wc, rawUrl);
    if (fromTunnel && isRemoteHttpUrlForMenu(fromTunnel)) return fromTunnel;
  }

  if (isOnActiveProxyOrigin(rawUrl, settings) && wc && !wc.isDestroyed()) {
    const cached = guestSitePageByWcId.get(wc.id);
    if (cached && cached.url && isRemoteHttpUrlForMenu(cached.url)) {
      return cached.url;
    }
    const page = await probeGuestSitePage(wc);
    if (page && page.url && isRemoteHttpUrlForMenu(page.url)) {
      rememberGuestSitePage(wc.id, page);
      return page.url;
    }
    const tunnel = await decodeTunnelHrefInGuest(wc, rawUrl);
    if (tunnel && isRemoteHttpUrlForMenu(tunnel)) return tunnel;
  }

  if (isRemoteHttpUrlForMenu(rawUrl)) return rawUrl;
  const display = cleanUrlForContextMenu(rawUrl);
  if (isRemoteHttpUrlForMenu(display)) return display;
  return '';
}

function wrapRemoteForProxyClipboard(remote, settings) {
  if (!remote) return '';
  return wrapUrlForProxyIfNeededMenu(remote, settings);
}

function getPlainUrlForClipboard(
  wc,
  rawUrl,
  displayUrl,
  settings,
  linkTarget,
  pageRemote
) {
  if (linkTarget) return linkTarget;
  if (pageRemote) return pageRemote;
  if (settings.proxyEnabled === false) {
    return displayUrl || rawUrl;
  }
  return displayUrl || rawUrl;
}

async function getProxiedUrlForClipboard(
  wc,
  rawUrl,
  displayUrl,
  settings,
  linkTarget,
  pageRemote
) {
  const remote =
    linkTarget || pageRemote || (await resolvePageRemoteUrlForClipboard(wc, rawUrl, settings));
  if (remote) return wrapRemoteForProxyClipboard(remote, settings);
  if (settings.proxyEnabled === false) {
    return displayUrl || rawUrl;
  }
  return wrapUrlForProxyIfNeededMenu(displayUrl || rawUrl, settings);
}

function wrapUrlForProxyIfNeededMenu(url, settings) {
  if (!url || typeof url !== 'string') return url;
  if (url.startsWith('bavarium://') || url.startsWith('file://')) return url;
  if (settings.proxyEnabled === false) return url;

  try {
    const u = new URL(url);
    const selPort = parseInt(
      String(
        settings.proxyType === 'scramjet'
          ? settings.scramjetPort || 3000
          : settings.uvPort || 8080
      ),
      10
    );
    if (
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1') &&
      parseInt(u.port || '80', 10) === selPort &&
      u.searchParams.has('url')
    ) {
      return url;
    }
  } catch {
    /* ignore */
  }

  const isLocal = url.includes('localhost') || url.startsWith('file://');
  if (
    !isLocal &&
    (settings.proxyType === 'ultraviolet' || settings.proxyType === 'scramjet')
  ) {
    const port =
      settings.proxyType === 'ultraviolet'
        ? settings.uvPort || 8080
        : settings.scramjetPort || 3000;
    return `http://localhost:${port}/?url=${encodeURIComponent(url)}`;
  }
  return url;
}

function viewSourceUrlForNewTabMenu(displayUrl, rawUrl) {
  if (displayUrl && /^https?:\/\//i.test(displayUrl)) {
    return `view-source:${displayUrl}`;
  }
  if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
    return `view-source:${rawUrl}`;
  }
  if (rawUrl && rawUrl.startsWith('file:')) {
    return `view-source:${rawUrl}`;
  }
  return null;
}

function browserWindowForGuestWebContents(guestWc) {
  let w = BrowserWindow.fromWebContents(guestWc);
  if (w && !w.isDestroyed()) return w;
  const host = guestWc.hostWebContents;
  if (host && !host.isDestroyed()) {
    w = BrowserWindow.fromWebContents(host);
    if (w && !w.isDestroyed()) return w;
  }
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  return getAppBrowserWindows().find((x) => !x.isDestroyed()) || null;
}

function guestWebviewIsIncognito(wc) {
  try {
    return wc.session === session.fromPartition(INCOGNITO_PARTITION);
  } catch {
    return false;
  }
}

function guestShortcutModifierDown(input) {
  return process.platform === 'darwin' ? !!input.meta : !!input.control;
}

async function saveGuestWebContentsAs(wc) {
  if (!wc || wc.isDestroyed()) return;
  const win = browserWindowForGuestWebContents(wc);
  let rawUrl = '';
  try {
    rawUrl = wc.getURL() || '';
  } catch (_) {}
  let defaultName = 'page.html';
  try {
    const t = (wc.getTitle() || '').trim();
    if (t) {
      const safe = t.replace(/[/\\?%*:|"<>]/g, '').slice(0, 100);
      if (safe) defaultName = `${safe}.html`;
    }
  } catch (_) {}
  const r = await dialog.showSaveDialog(win || dialogParentWindow(), {
    title: 'Save Page As',
    defaultPath: defaultName,
    filters: [
      { name: 'Web Page, Complete', extensions: ['html', 'htm'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePath) return;
  let savePath = r.filePath;
  if (!/\.html?$/i.test(savePath)) {
    savePath += '.html';
  }
  try {
    await wc.savePage(savePath, 'HTMLComplete');
    if (!guestWebviewIsIncognito(wc)) {
      appendDownloadRecord({
        name: path.basename(savePath),
        path: savePath,
        state: 'completed',
        url: rawUrl,
      });
    }
  } catch (e) {
    console.warn('Save page:', e);
  }
}

function bindGuestWebviewShortcuts(wc) {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !guestShortcutModifierDown(input)) return;
    const key = (input.key || '').toLowerCase();

    if (!input.shift && !input.alt && key === 's') {
      event.preventDefault();
      void saveGuestWebContentsAs(wc);
      return;
    }

    if (input.shift && !input.alt && key === 'i' && chromiumDevToolsEnabled()) {
      event.preventDefault();
      const host = wc.hostWebContents;
      if (host && !host.isDestroyed()) {
        host.send('bavarium-devtools-hotkey', { webContentsId: wc.id });
      }
    }
  });
}

function registerGuestWebviewContextMenu() {
  app.on('web-contents-created', (_event, wc) => {
    wc.once('destroyed', () => {
      guestSiteOriginByWcId.delete(wc.id);
      guestSitePageByWcId.delete(wc.id);
    });

    if (wc.getType() !== 'webview') return;
    bindGuestWebviewShortcuts(wc);
    wc.on('console-message', (...args) => {
      const details = parseGuestConsoleMessageArgs(args);
      if (details) forwardGuestConsoleMessageToShell(wc, details);
    });
    const reinject = () => injectFrameRateCapOnWebContents(wc);
    reinject();
    wc.on('did-finish-load', reinject);
    wc.on('did-navigate-in-page', reinject);
    wc.on('will-navigate', (event, navUrl) => {
      const url = typeof navUrl === 'string' ? navUrl : '';
      if (!url || url.startsWith('bavarium://')) return;
      if (isHttpUrl(url)) {
        let guestPageUrl = '';
        try {
          guestPageUrl = wc.getURL();
        } catch (_) {}
        if (isUnsafeWarningPageUrl(guestPageUrl)) return;
        if (isBavariumShellFilePageUrl(guestPageUrl)) {
          event.preventDefault();
          const host = wc.hostWebContents;
          if (host && !host.isDestroyed()) {
            host.send('bavarium-shell-external-link', {
              url,
              incognito: guestWebviewIsIncognito(wc),
            });
          }
          return;
        }
        event.preventDefault();
        void (async () => {
          const unsafeHit = await checkSafeBrowsingForNavigation(url);
          if (unsafeHit) {
            const host = wc.hostWebContents;
            if (host && !host.isDestroyed()) {
              host.send('bavarium-unsafe-site-blocked', unsafeHit);
            }
            return;
          }
          try {
            if (!wc.isDestroyed()) wc.loadURL(url);
          } catch (_) {}
        })();
        return;
      }
      event.preventDefault();
      openExternalUrlFromGuest(wc, url);
    });

    wc.setWindowOpenHandler((details) => {
      const openUrl = details.url || '';
      if (
        !openUrl ||
        openUrl === 'about:blank' ||
        openUrl.startsWith('javascript:') ||
        openUrl.startsWith('data:')
      ) {
        return { action: 'deny' };
      }

      if (isDownloadWindowDisposition(details.disposition) && isHttpUrl(openUrl)) {
        try {
          wc.downloadURL(openUrl);
        } catch (e) {
          console.warn('downloadURL:', e);
        }
        return { action: 'deny' };
      }

      if (!isHttpUrl(openUrl)) {
        openExternalUrlFromGuest(wc, openUrl);
        return { action: 'deny' };
      }

      const host = wc.hostWebContents;
      if (host && !host.isDestroyed()) {
        const background = details.disposition === 'background-tab';
        let guestPageUrl = '';
        try {
          guestPageUrl = wc.getURL();
        } catch (_) {}
        void (async () => {
          const unsafeHit = await checkSafeBrowsingForNavigation(openUrl);
          if (unsafeHit) {
            host.send('bavarium-unsafe-site-blocked', {
              ...unsafeHit,
              openInNewTab: true,
              background,
              incognito: guestWebviewIsIncognito(wc),
            });
            return;
          }
          if (isBavariumShellFilePageUrl(guestPageUrl)) {
            host.send('bavarium-shell-external-link', {
              url: openUrl,
              background,
              incognito: guestWebviewIsIncognito(wc),
            });
            return;
          }
          host.send('bavarium-new-tab-with-url', {
            url: openUrl,
            background,
            incognito: guestWebviewIsIncognito(wc),
          });
        })();
      }
      return { action: 'deny' };
    });
    wc.on('context-menu', (event, params) => {
      event.preventDefault();
      void popupGuestWebviewContextMenu(wc, params);
    });
  });
}

async function popupGuestWebviewContextMenu(wc, params) {
  const settings = mergedSettingsFromDisk();
  let rawUrl = '';
  try {
    rawUrl = wc.getURL() || '';
  } catch (_) {}
  const displayUrl = cleanUrlForContextMenu(rawUrl);
  const editFlags = params.editFlags || {};
  const win = browserWindowForGuestWebContents(wc);

  const linkTarget = await resolveContextMenuLinkTarget(wc, rawUrl, params);
  const pageRemote = linkTarget
    ? ''
    : await resolvePageRemoteUrlForClipboard(wc, rawUrl, settings);
  const hasLink = !!linkTarget;

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    {
      label: 'Copy',
      accelerator: 'CommandOrControl+C',
      enabled: !!editFlags.canCopy,
      click: () => {
        try {
          wc.copy();
        } catch (_) {}
      },
    },
    {
      label: 'Paste',
      accelerator: 'CommandOrControl+V',
      enabled: !!editFlags.canPaste,
      click: () => {
        try {
          wc.paste();
        } catch (_) {}
      },
    },
    { type: 'separator' },
    {
      label: hasLink ? 'Copy link URL' : 'Copy URL',
      enabled: !!(hasLink || pageRemote || displayUrl || rawUrl),
      click: () => {
        try {
          const text = getPlainUrlForClipboard(
            wc,
            rawUrl,
            displayUrl,
            settings,
            linkTarget,
            pageRemote
          );
          if (text) clipboard.writeText(text);
        } catch (err) {
          console.warn('Copy URL:', err);
        }
      },
    },
    {
      label: hasLink ? 'Copy proxied link URL' : 'Copy proxied URL',
      enabled:
        hasLink ||
        canCopyProxiedUrlMenu(rawUrl, displayUrl, settings, params.linkURL),
      click: async () => {
        try {
          const text = await getProxiedUrlForClipboard(
            wc,
            rawUrl,
            displayUrl,
            settings,
            linkTarget,
            pageRemote
          );
          if (text) clipboard.writeText(text);
        } catch (err) {
          console.warn('Copy proxied URL:', err);
        }
      },
    },
  ];

  const canShare =
    process.platform === 'darwin' &&
    typeof ShareMenu === 'function' &&
    !!displayUrl &&
    !displayUrl.startsWith('bavarium://');
  if (canShare) {
    template.push({
      label: 'Share Page…',
      click: () => {
        try {
          let title = '';
          try {
            title = (wc.getTitle() || '').trim();
          } catch (_) {}
          /** @type {{ urls: string[]; texts?: string[] }} */
          const item = { urls: [displayUrl] };
          if (title) item.texts = [title];
          const shareMenu = new ShareMenu(item);
          shareMenu.popup({
            window: win || undefined,
            x: params.x,
            y: params.y,
          });
        } catch (err) {
          console.error('Share menu:', err);
        }
      },
    });
  }

  const vs = viewSourceUrlForNewTabMenu(displayUrl, rawUrl);
  template.push(
        { type: 'separator' },
        {
          label: 'Save As…',
          accelerator: 'CommandOrControl+S',
          click: () => {
            void saveGuestWebContentsAs(wc);
          },
        },
        {
          label: 'View Page Source',
          enabled: !!vs,
          click: () => {
            const wrapped = wrapUrlForProxyIfNeededMenu(vs, mergedSettingsFromDisk());
            const host = wc.hostWebContents;
            if (host && !host.isDestroyed()) {
              host.send('bavarium-new-tab-with-url', wrapped);
            }
          },
        },
        ...(chromiumDevToolsEnabled()
          ? [
              {
                label: 'Inspect Element',
                accelerator: 'CommandOrControl+Shift+I',
                click: () => {
                  try {
                    wc.inspectElement(params.x, params.y);
                  } catch (_) {}
                },
              },
            ]
          : []),
  );

  const menu = Menu.buildFromTemplate(template);
  menu.popup({
    window: win || undefined,
    x: params.x,
    y: params.y,
  });
}

function historyFilePath() {
  return path.join(app.getPath('userData'), 'bavarium-history.json');
}

function readHistoryFile() {
  try {
    const p = historyFilePath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (e) {
    console.error('readHistoryFile', e);
  }
  return [];
}

function writeHistoryFile(items) {
  fs.writeFileSync(historyFilePath(), JSON.stringify(items, null, 2));
}

const HOMEPAGE_FAVORITES_MAX = 9;

function homepageFavoritesFilePath() {
  return path.join(app.getPath('userData'), 'bavarium-homepage-favorites.json');
}

function readHomepageFavoritesFile() {
  try {
    const p = homepageFavoritesFilePath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (e) {
    console.error('readHomepageFavoritesFile', e);
  }
  return [];
}

function writeHomepageFavoritesFile(items) {
  const list = Array.isArray(items) ? items.slice(0, HOMEPAGE_FAVORITES_MAX) : [];
  fs.writeFileSync(homepageFavoritesFilePath(), JSON.stringify(list, null, 2));
}

async function fetchSearchSuggestions(query, searchEngine) {
  const q = encodeURIComponent(String(query || '').trim());
  if (!q) return [];
  const engine = searchEngine || 'google';
  try {
    if (engine === 'duckduckgo') {
      const res = await fetch(`https://duckduckgo.com/ac/?q=${q}&type=list`);
      const data = await res.json();
      return (data || [])
        .map((row) => (Array.isArray(row) ? row[0] : row && row.phrase))
        .filter(Boolean)
        .slice(0, 8);
    }
    if (engine === 'brave') {
      const res = await fetch(`https://search.brave.com/api/suggest?q=${q}`);
      const data = await res.json();
      return (data.results || [])
        .map((r) => r.title || r.query || r.url)
        .filter(Boolean)
        .slice(0, 8);
    }
    if (engine === 'yandex') {
      const res = await fetch(
        `https://suggest.yandex.com/suggest-ff.cgi?part=${q}&n=8`
      );
      const data = await res.json();
      return (data[1] || []).slice(0, 8);
    }
    const res = await fetch(
      `https://suggestqueries.google.com/complete/search?client=firefox&q=${q}`
    );
    const data = await res.json();
    return (data[1] || []).slice(0, 8);
  } catch (e) {
    console.warn('fetchSearchSuggestions', e);
    return [];
  }
}

function downloadsFilePath() {
  return path.join(app.getPath('userData'), 'bavarium-downloads.json');
}

function readDownloadsFile() {
  try {
    const p = downloadsFilePath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (e) {
    console.error('readDownloadsFile', e);
  }
  return [];
}

function writeDownloadsFile(items) {
  fs.writeFileSync(downloadsFilePath(), JSON.stringify(items, null, 2));
}

const BAVARIUM_WEB_PARTITION = 'persist:bavarium';

/** Drop stale SW / IndexedDB on the local proxy origin (avoids IDB schema mismatches). */
async function clearProxyShellStorageForPort(port) {
  const storages = ['indexdb', 'serviceworkers', 'cachestorage'];
  const origins = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ];
  for (const partition of [BAVARIUM_WEB_PARTITION]) {
    const ses = session.fromPartition(partition);
    for (const origin of origins) {
      try {
        await ses.clearStorageData({ origin, storages });
      } catch (e) {
        console.warn('clearProxyShellStorageForPort', partition, origin, e);
      }
    }
  }
}

/** Permissions exposed in Settings → History/Privacy. */
const SITE_PERMISSION_TYPES = [
  { id: 'geolocation', label: 'Location' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'media', label: 'Camera & microphone' },
  { id: 'fullscreen', label: 'Fullscreen' },
  { id: 'pointerLock', label: 'Pointer lock' },
  { id: 'clipboard-read', label: 'Clipboard read' },
  { id: 'display-capture', label: 'Screen capture' },
  { id: 'openExternal', label: 'Open external links' },
];

const SITE_PERMISSION_IDS = new Set(SITE_PERMISSION_TYPES.map((p) => p.id));

const SITE_PERMISSION_LABELS = Object.fromEntries(
  SITE_PERMISSION_TYPES.map((p) => [p.id, p.label])
);

function sitePermissionsFilePath() {
  return path.join(app.getPath('userData'), 'site-permissions.json');
}

function readSitePermissionsStore() {
  try {
    const p = sitePermissionsFilePath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (data && typeof data.origins === 'object' && data.origins !== null) {
        return data;
      }
    }
  } catch (e) {
    console.error('readSitePermissionsStore', e);
  }
  return { origins: {} };
}

function writeSitePermissionsStore(data) {
  fs.writeFileSync(sitePermissionsFilePath(), JSON.stringify(data, null, 2));
}

function normalizeSiteOrigin(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

function isProxyShellOrigin(origin, settings) {
  if (!origin) return false;
  const loc = parseLocalhostPortMenu(origin);
  if (!loc) return false;
  const expected = activeProxyPortFromSettings(settings || mergedSettingsFromDisk());
  if (expected === null) return false;
  return loc.port === expected;
}

function unwrapProxiedTargetOrigin(url, settings) {
  if (!url || typeof url !== 'string') return null;
  const disk = settings || mergedSettingsFromDisk();
  try {
    const u = new URL(url);
    if (
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1') &&
      u.searchParams.has('url')
    ) {
      return normalizeSiteOrigin(decodeURIComponent(u.searchParams.get('url')));
    }
  } catch {
    /* ignore */
  }
  const o = normalizeSiteOrigin(url);
  if (o && !isProxyShellOrigin(o, disk)) return o;
  return null;
}

function resolveSiteOriginSync(rawUrl, settings, details) {
  const disk = settings || mergedSettingsFromDisk();
  const candidates = [
    details && details.requestingUrl,
    details && details.embeddingOrigin,
    rawUrl,
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const unwrapped = unwrapProxiedTargetOrigin(raw, disk);
    if (unwrapped) return unwrapped;
    const o = normalizeSiteOrigin(raw);
    if (o && !isProxyShellOrigin(o, disk)) return o;
  }
  return null;
}

function rememberGuestSiteOrigin(webContentsId, origin) {
  const id = Number(webContentsId);
  const o = normalizeSiteOrigin(origin || '');
  if (!Number.isFinite(id) || !o) return;
  if (isProxyShellOrigin(o, mergedSettingsFromDisk())) return;
  guestSiteOriginByWcId.set(id, o);
}

function normalizeGuestPageProbe(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url =
    typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim() : '';
  const title =
    typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : '';
  const origin =
    normalizeSiteOrigin(raw.origin || url) ||
    (url ? normalizeSiteOrigin(url) : null);
  const favicon =
    typeof raw.favicon === 'string' && raw.favicon.trim()
      ? raw.favicon.trim()
      : '';
  if (!origin && !url && !title) return null;
  let resolvedTitle = title;
  if (!resolvedTitle && url) {
    try {
      resolvedTitle = new URL(url).hostname;
    } catch (_) {
      resolvedTitle = '';
    }
  }
  return {
    origin: origin || '',
    url,
    title: resolvedTitle,
    favicon,
  };
}

function rememberGuestSitePage(webContentsId, page) {
  const id = Number(webContentsId);
  const normalized = normalizeGuestPageProbe(page);
  if (!Number.isFinite(id) || !normalized) return;
  const settings = mergedSettingsFromDisk();
  if (normalized.origin && !isProxyShellOrigin(normalized.origin, settings)) {
    guestSiteOriginByWcId.set(id, normalized.origin);
  }
  if (normalized.url || normalized.title) {
    guestSitePageByWcId.set(id, normalized);
  }
}

async function probeGuestSitePage(wc) {
  if (!wc || wc.isDestroyed()) return null;
  try {
    const result = await wc.executeJavaScript(GUEST_SITE_PAGE_PROBE, true);
    return normalizeGuestPageProbe(result);
  } catch (_) {
    /* guest may block script */
  }
  return null;
}

async function probeGuestSiteOrigin(wc) {
  const page = await probeGuestSitePage(wc);
  if (page && page.origin) return page.origin;
  return null;
}

async function resolveGuestSiteOrigin(wc, details) {
  if (!wc || wc.isDestroyed()) return null;
  const cached = guestSiteOriginByWcId.get(wc.id);
  if (cached) return cached;

  const settings = mergedSettingsFromDisk();
  const sync = resolveSiteOriginSync(
    typeof wc.getURL === 'function' ? wc.getURL() : '',
    settings,
    details
  );
  if (sync) {
    guestSiteOriginByWcId.set(wc.id, sync);
    return sync;
  }

  const probed = await probeGuestSitePage(wc);
  if (probed) {
    rememberGuestSitePage(wc.id, probed);
    if (probed.origin && !isProxyShellOrigin(probed.origin, settings)) {
      return probed.origin;
    }
  }
  return null;
}

function resolveSiteOriginFromGuestSync(wc, details, requestingOrigin) {
  if (!wc || wc.isDestroyed()) return null;
  const settings = mergedSettingsFromDisk();
  const cached = guestSiteOriginByWcId.get(wc.id);
  if (cached) return cached;

  const sync = resolveSiteOriginSync(
    typeof wc.getURL === 'function' ? wc.getURL() : '',
    settings,
    details
  );
  if (sync) {
    guestSiteOriginByWcId.set(wc.id, sync);
    return sync;
  }

  const ro = normalizeSiteOrigin(requestingOrigin || '');
  if (ro && !isProxyShellOrigin(ro, settings)) return ro;
  return null;
}

function hostnameFromOrigin(origin) {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

function getSitePermissionRule(origin, permission) {
  const store = readSitePermissionsStore();
  const site = store.origins[origin];
  if (!site || typeof site !== 'object') return 'ask';
  const rule = site[permission];
  return rule === 'allow' || rule === 'block' ? rule : 'ask';
}

function ensureSiteOriginRecorded(origin) {
  const store = readSitePermissionsStore();
  if (!store.origins[origin]) {
    store.origins[origin] = {};
    writeSitePermissionsStore(store);
  }
}

function setSitePermissionRule(origin, permission, rule) {
  if (!SITE_PERMISSION_IDS.has(permission)) {
    return { ok: false, error: 'unknown-permission' };
  }
  const store = readSitePermissionsStore();
  if (!store.origins[origin]) store.origins[origin] = {};
  if (rule === 'ask') {
    delete store.origins[origin][permission];
    if (Object.keys(store.origins[origin]).length === 0) {
      delete store.origins[origin];
    }
  } else if (rule === 'allow' || rule === 'block') {
    store.origins[origin][permission] = rule;
  } else {
    return { ok: false, error: 'invalid-rule' };
  }
  writeSitePermissionsStore(store);
  return { ok: true };
}

function clearAllSitePermissionsStore() {
  writeSitePermissionsStore({ origins: {} });
}

function originFromPermissionContext(webContents, details, requestingOrigin) {
  return resolveSiteOriginFromGuestSync(webContents, details, requestingOrigin);
}

function promptSitePermissionDecision(parentWin, origin, permission) {
  const label = SITE_PERMISSION_LABELS[permission] || permission;
  const host = hostnameFromOrigin(origin);
  return dialog.showMessageBox(parentWin || undefined, {
    type: 'question',
    buttons: ['Allow once', 'Block', 'Always allow', 'Always block'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: 'Site permission',
    message: `${host} wants to use ${label}`,
    detail: origin,
  });
}

function setupBavariumSitePermissionHandlers() {
  const ses = session.fromPartition(BAVARIUM_WEB_PARTITION);

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (!SITE_PERMISSION_IDS.has(permission)) return false;
    const origin = originFromPermissionContext(
      webContents,
      details,
      requestingOrigin
    );
    if (!origin) return false;
    const rule = getSitePermissionRule(origin, permission);
    if (rule === 'allow') return true;
    if (rule === 'block') return false;
    return false;
  });

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (!SITE_PERMISSION_IDS.has(permission)) {
      callback(false);
      return;
    }

    const finish = (origin) => {
      if (!origin) {
        callback(false);
        return;
      }
      const rule = getSitePermissionRule(origin, permission);
      if (rule === 'allow') {
        ensureSiteOriginRecorded(origin);
        callback(true);
        return;
      }
      if (rule === 'block') {
        callback(false);
        return;
      }

      const parent = webContents
        ? browserWindowForGuestWebContents(webContents)
        : dialogParentWindow();
      promptSitePermissionDecision(parent, origin, permission)
        .then(({ response }) => {
          if (response === 2) {
            setSitePermissionRule(origin, permission, 'allow');
            ensureSiteOriginRecorded(origin);
            callback(true);
          } else if (response === 3) {
            setSitePermissionRule(origin, permission, 'block');
            ensureSiteOriginRecorded(origin);
            callback(false);
          } else if (response === 0) {
            ensureSiteOriginRecorded(origin);
            callback(true);
          } else {
            callback(false);
          }
        })
        .catch(() => callback(false));
    };

    resolveGuestSiteOrigin(webContents, details)
      .then(finish)
      .catch(() => callback(false));
  });
}

function uniqueDiskPath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  let n = 1;
  let candidate;
  do {
    candidate = path.join(dir, `${base} (${n})${ext}`);
    n++;
  } while (fs.existsSync(candidate) && n < 10000);
  return candidate;
}

function appendDownloadRecord(entry) {
  const list = readDownloadsFile();
  list.unshift({
    id: entry.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: entry.name || 'Download',
    path: entry.path || '',
    state: entry.state || 'completed',
    url: entry.url || '',
    ts: entry.ts != null ? entry.ts : Date.now(),
  });
  writeDownloadsFile(list.slice(0, DOWNLOAD_RECORD_LIMIT));
  broadcastToAllWindows('downloads-updated');
}

function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:/i.test(url);
}

function isDownloadWindowDisposition(disposition) {
  return (
    disposition === 'save-to-disk' ||
    disposition === 'save-to-disk-user-action'
  );
}

function openExternalUrlFromGuest(guestWc, url) {
  if (!url || typeof url !== 'string') return;
  if (isHttpUrl(url) || url.startsWith('bavarium:')) return;

  const origin = resolveSiteOriginFromGuestSync(
    guestWc,
    null,
    guestWc && typeof guestWc.getURL === 'function' ? guestWc.getURL() : ''
  );
  const win = guestWc
    ? browserWindowForGuestWebContents(guestWc)
    : dialogParentWindow();

  const runOpen = () => {
    shell.openExternal(url).catch((e) => {
      console.warn('openExternal:', e);
      if (win && !win.isDestroyed()) {
        dialog.showMessageBox(win, {
          type: 'error',
          title: 'Could not open link',
          message: 'No application is registered for this link.',
          detail: url,
        });
      }
    });
  };

  if (!origin) {
    runOpen();
    return;
  }

  const rule = getSitePermissionRule(origin, 'openExternal');
  if (rule === 'allow') {
    runOpen();
    return;
  }
  if (rule === 'block') {
    if (win && !win.isDestroyed()) {
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Link blocked',
        message: 'This site is not allowed to open external links.',
        detail: url,
      });
    }
    return;
  }

  dialog
    .showMessageBox(win || undefined, {
      type: 'question',
      buttons: ['Open', 'Cancel', 'Always allow', 'Always block'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: 'Open external link',
      message: 'Open this link in your default application?',
      detail: url,
    })
    .then(({ response }) => {
      if (response === 0) {
        runOpen();
      } else if (response === 2) {
        setSitePermissionRule(origin, 'openExternal', 'allow');
        ensureSiteOriginRecorded(origin);
        runOpen();
      } else if (response === 3) {
        setSitePermissionRule(origin, 'openExternal', 'block');
        ensureSiteOriginRecorded(origin);
      }
    })
    .catch(() => {});
}

function setupDownloadHandlersForPartition(partition, recordInDownloadManager) {
  const ses = session.fromPartition(partition);
  if (ses.__bavariumDownloadsHooked) return;
  ses.__bavariumDownloadsHooked = true;

  ses.on('will-download', (event, item) => {
    trackActiveDownloadItem(item);
    const s = loadSettings();
    const ask = s.askBeforeDownload !== false;
    const baseDir =
      (s.downloadPath && String(s.downloadPath).trim()) ||
      app.getPath('downloads');
    const fileName = item.getFilename() || 'download';
    const sourceUrl = item.getURL() || '';
    let recorded = false;

    const recordIfNeeded = (state) => {
      if (!recordInDownloadManager || recorded) return;
      recorded = true;
      appendDownloadRecord({
        name: fileName,
        path: item.getSavePath() || '',
        state: state || 'completed',
        url: sourceUrl,
      });
    };

    item.on('done', (_e, state) => {
      recordIfNeeded(state);
    });

    if (ask) {
      /*
       * Do not call preventDefault() before a path exists: with an async dialog,
       * Electron cancels the download. Let the default flow run and only customize
       * the save dialog via setSaveDialogOptions.
       */
      item.setSaveDialogOptions({
        title: 'Save As',
        defaultPath: path.join(baseDir, fileName),
        buttonLabel: 'Save',
      });
      return;
    }

    event.preventDefault();
    const savePath = uniqueDiskPath(path.join(baseDir, fileName));
    item.setSavePath(savePath);
  });
}

function setupDownloadSession() {
  setupDownloadHandlersForPartition('persist:bavarium', true);
  setupDownloadHandlersForPartition(INCOGNITO_PARTITION, false);
}

async function startSelectedProxy() {
  const settings = loadSettings();

  stopProxy();
  await delayMs(400);

  if (settings.proxyEnabled === false) {
    broadcastProxyPortState({
      status: 'disabled',
      ready: true,
      message: 'Proxy is disabled.',
    });
    return null;
  }

  const proxyType = normalizeProxyTypeFromDisk(settings.proxyType || 'ultraviolet');
  const preferred =
    proxyType === 'ultraviolet'
      ? settings.uvPort || '8080'
      : settings.scramjetPort || '3000';

  const label = proxyType === 'scramjet' ? 'Scramjet' : 'Ultraviolet';
  broadcastProxyPortState({
    status: 'starting',
    proxyType,
    port: parseInt(String(preferred), 10) || defaultPortForProxyType(proxyType),
    message: `Starting ${label} proxy…`,
    ready: false,
  });

  return startProxyWithResolvedPort(proxyType, preferred, { atStartup: true });
}

// 🔥 LIVE SWITCHING
ipcMain.on('change-proxy', (event, settings) => {
  console.log('Switching proxy...');

  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Failed to persist settings:', err);
  }

  stopProxy();

  if (settings.proxyEnabled === false) {
    broadcastToAllWindows('settings-updated', settings);
    applyFrameRateSettingsToAll(settings);
    return;
  }

  const proxyType = normalizeProxyTypeFromDisk(settings.proxyType || 'ultraviolet');
  const preferred =
    proxyType === 'ultraviolet'
      ? settings.uvPort || '8080'
      : settings.scramjetPort || '3000';

  void (async () => {
    await delayMs(400);
    const port = await startProxyWithResolvedPort(proxyType, preferred);
    if (port == null) return;
    const merged = mergedSettingsFromDisk();
    applyFrameRateSettingsToAll(merged);
    broadcastToAllWindows('proxy-switched');
  })();
});

const BAVARIUM_GITHUB_REPO = 'yourworstnightmare1/bavarium-browser';
const BAVARIUM_GITHUB_REPO_URL = `https://github.com/${BAVARIUM_GITHUB_REPO}`;

let cachedAppPackageJson = null;

function readAppPackageJson() {
  if (cachedAppPackageJson) return cachedAppPackageJson;
  try {
    cachedAppPackageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')
    );
  } catch (_) {
    cachedAppPackageJson = {
      name: 'bavarium-browser',
      productName: APP_DISPLAY_NAME,
      version: '0.0.0',
      bavariumDisplayVersion: 'v0.0.0',
    };
  }
  return cachedAppPackageJson;
}

function normalizeVersionLabel(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .trim()
    .toLowerCase();
}

function installedBrowserVersionLabels() {
  const pkg = readAppPackageJson();
  const labels = new Set();
  if (pkg.version) labels.add(normalizeVersionLabel(pkg.version));
  if (pkg.bavariumDisplayVersion) {
    labels.add(normalizeVersionLabel(pkg.bavariumDisplayVersion));
  }
  return labels;
}

function releaseMatchesInstalled(tagName) {
  const t = normalizeVersionLabel(tagName);
  return installedBrowserVersionLabels().has(t);
}

function readLocalGitCommitShortSync() {
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf8',
      timeout: 5000,
    });
    const s = String(out || '').trim();
    return s || null;
  } catch (_) {
    return null;
  }
}

async function fetchGithubApiJson(apiPath) {
  const url = apiPath.startsWith('https://')
    ? apiPath
    : `https://api.github.com${apiPath}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Bavarium-Browser',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `GitHub API ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`
    );
  }
  return res.json();
}

async function getLatestGithubRelease({ prereleaseOnly = false, stableOnly = false } = {}) {
  const releases = await fetchGithubApiJson(
    `/repos/${BAVARIUM_GITHUB_REPO}/releases?per_page=40`
  );
  if (!Array.isArray(releases)) return null;
  for (const r of releases) {
    if (r.draft) continue;
    if (prereleaseOnly && !r.prerelease) continue;
    if (stableOnly && r.prerelease) continue;
    return r;
  }
  return null;
}

async function getLatestGithubCommitOnDefaultBranch() {
  const repo = await fetchGithubApiJson(`/repos/${BAVARIUM_GITHUB_REPO}`);
  const branch = (repo && repo.default_branch) || 'main';
  const commit = await fetchGithubApiJson(
    `/repos/${BAVARIUM_GITHUB_REPO}/commits/${encodeURIComponent(branch)}`
  );
  if (!commit || !commit.sha) return null;
  return {
    branch,
    sha: commit.sha,
    shortSha: commit.sha.slice(0, 7),
    message:
      (commit.commit && commit.commit.message) ||
      '',
    htmlUrl: commit.html_url || `${BAVARIUM_GITHUB_REPO_URL}/commit/${commit.sha}`,
    date: (commit.commit && commit.commit.committer && commit.commit.committer.date) || null,
  };
}

function pickReleaseDownloadUrl(release) {
  if (!release) return `${BAVARIUM_GITHUB_REPO_URL}/releases`;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  if (assets.length) {
    const patterns =
      process.platform === 'win32'
        ? [/\.exe$/i, /\.msi$/i, /win/i, /windows/i]
        : process.platform === 'darwin'
          ? [/\.dmg$/i, /mac/i, /darwin/i]
          : [/\.appimage$/i, /\.deb$/i, /linux/i];
    for (const re of patterns) {
      const hit = assets.find((a) => re.test(a.name || ''));
      if (hit && hit.browser_download_url) return hit.browser_download_url;
    }
    const first = assets.find((a) => a.browser_download_url);
    if (first && first.browser_download_url) return first.browser_download_url;
  }
  return release.html_url || `${BAVARIUM_GITHUB_REPO_URL}/releases`;
}

function formatGithubReleaseSummary(release) {
  if (!release) return null;
  return {
    tag: release.tag_name || '',
    name: release.name || release.tag_name || '',
    prerelease: !!release.prerelease,
    publishedAt: release.published_at || null,
    htmlUrl: release.html_url || `${BAVARIUM_GITHUB_REPO_URL}/releases`,
    downloadUrl: pickReleaseDownloadUrl(release),
    body: release.body || '',
  };
}

async function getAboutBrowserInfo() {
  const pkg = readAppPackageJson();
  const settings = mergedSettingsFromDisk();
  const trackPreRelease = settings.trackPreReleaseUpdates === true;
  const info = {
    appName: pkg.productName || APP_DISPLAY_NAME,
    browserVersion: pkg.bavariumDisplayVersion || pkg.version || '—',
    browserVersionRaw: pkg.version || '—',
    electronVersion: process.versions.electron || '—',
    trackPreReleaseUpdates: trackPreRelease,
    localCommit: null,
    latestCommit: null,
    repoUrl: BAVARIUM_GITHUB_REPO_URL,
  };
  if (trackPreRelease) {
    info.localCommit = readLocalGitCommitShortSync();
    try {
      info.latestCommit = await getLatestGithubCommitOnDefaultBranch();
    } catch (e) {
      info.latestCommitError = e && e.message ? e.message : String(e);
    }
  }
  return info;
}

async function checkBavariumBrowserUpdates({ prerelease = false } = {}) {
  const installed = readAppPackageJson();
  const currentLabel =
    installed.bavariumDisplayVersion || installed.version || 'unknown';
  try {
    if (prerelease) {
      const release = await getLatestGithubRelease({ prereleaseOnly: true });
      if (release) {
        const summary = formatGithubReleaseSummary(release);
        const upToDate = releaseMatchesInstalled(summary.tag);
        return {
          ok: true,
          channel: 'prerelease',
          upToDate,
          current: currentLabel,
          release: summary,
          downloadUrl: summary.downloadUrl,
          message: upToDate
            ? `You have the latest pre-release (${summary.tag}).`
            : `Pre-release available: ${summary.tag}\n${summary.htmlUrl}`,
        };
      }
      const commit = await getLatestGithubCommitOnDefaultBranch();
      const local = readLocalGitCommitShortSync();
      const upToDate =
        local && commit && local.toLowerCase() === commit.shortSha.toLowerCase();
      return {
        ok: true,
        channel: 'commit',
        upToDate,
        current: currentLabel,
        commit,
        localCommit: local,
        downloadUrl: commit.htmlUrl,
        message: upToDate
          ? `Your build matches the latest commit on ${commit.branch} (${commit.shortSha}).`
          : `Newer commits on ${commit.branch}: ${commit.shortSha}\n${commit.htmlUrl}`,
      };
    }

    const release = await getLatestGithubRelease({ stableOnly: true });
    if (!release) {
      return {
        ok: true,
        upToDate: true,
        current: currentLabel,
        message: 'No stable GitHub releases found yet. Check pre-release builds if enabled.',
      };
    }
    const summary = formatGithubReleaseSummary(release);
    const upToDate = releaseMatchesInstalled(summary.tag);
    return {
      ok: true,
      channel: 'stable',
      upToDate,
      current: currentLabel,
      release: summary,
      downloadUrl: summary.downloadUrl,
      message: upToDate
        ? `You're on the latest release (${summary.tag}).`
        : `Update available: ${summary.tag}\n${summary.htmlUrl}`,
    };
  } catch (e) {
    return {
      ok: false,
      error: e && e.message ? e.message : String(e),
      current: currentLabel,
    };
  }
}

let startupUpdateCheckDone = false;
let updatePromptWin = null;
let pendingUpdatePromptResolve = null;

function buildUpdatePromptPayload(result, trackPreRelease) {
  const current = result.current || 'unknown';
  let downloadUrl =
    result.downloadUrl || `${BAVARIUM_GITHUB_REPO_URL}/releases`;
  const windowTitle = trackPreRelease
    ? 'Pre-release update available'
    : 'Update available';
  const headline = trackPreRelease
    ? 'A pre-release update is available for Bavarium Browser.'
    : 'A new version of Bavarium Browser is available.';
  let subtitle = `You are on ${current}.`;
  let detailsBody = '';

  if (result.channel === 'commit' && result.commit) {
    const c = result.commit;
    downloadUrl = c.htmlUrl || downloadUrl;
    subtitle += ` A newer build is on ${c.branch} (${c.shortSha}).`;
    detailsBody =
      (c.message && String(c.message).trim()) ||
      'Open GitHub to download the latest release or build from source.';
  } else if (result.release) {
    const r = result.release;
    downloadUrl = result.downloadUrl || r.downloadUrl || r.htmlUrl;
    subtitle += ` ${trackPreRelease ? 'Pre-release' : 'Version'} ${r.tag} is available.`;
    if (r.name && r.name !== r.tag) {
      subtitle += ` ${r.name}`;
    }
    const parts = [];
    if (r.publishedAt) {
      try {
        parts.push(
          `Published: ${new Date(r.publishedAt).toLocaleString()}`
        );
      } catch (_) {
        parts.push(`Published: ${r.publishedAt}`);
      }
    }
    if (r.htmlUrl) parts.push(r.htmlUrl);
    const notes = (r.body && String(r.body).trim()) || '';
    if (notes) {
      if (parts.length) parts.push('');
      parts.push(notes);
    } else if (!parts.length) {
      parts.push('No release notes provided on GitHub.');
    }
    detailsBody = parts.join('\n');
  } else {
    detailsBody =
      result.message || 'A newer version is available on GitHub.';
  }

  return {
    windowTitle,
    headline,
    subtitle,
    detailsBody,
    downloadUrl,
    trackPreRelease,
    downloadLabel: trackPreRelease
      ? 'Download pre-release'
      : 'Download update',
  };
}

function showUpdateAvailablePrompt(payload) {
  return new Promise((resolve) => {
    if (updatePromptWin && !updatePromptWin.isDestroyed()) {
      try {
        updatePromptWin.close();
      } catch (_) {}
    }
    pendingUpdatePromptResolve = resolve;
    const parent = dialogParentWindow();
    const iconPath = getAppIconPath();
    updatePromptWin = new BrowserWindow({
      width: 440,
      height: 400,
      minWidth: 360,
      minHeight: 300,
      maxHeight: 560,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: !!(parent && !parent.isDestroyed()),
      show: false,
      autoHideMenuBar: true,
      title: payload.windowTitle || 'Update available',
      ...(iconPath ? { icon: iconPath } : {}),
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
      },
    });
    updatePromptWin.on('closed', () => {
      updatePromptWin = null;
      if (pendingUpdatePromptResolve) {
        const done = pendingUpdatePromptResolve;
        pendingUpdatePromptResolve = null;
        done('later');
      }
    });
    updatePromptWin.loadFile(path.join(__dirname, 'update-prompt.html'));
    updatePromptWin.webContents.once('did-finish-load', () => {
      if (!updatePromptWin || updatePromptWin.isDestroyed()) return;
      updatePromptWin.webContents.send('update-prompt-init', payload);
      updatePromptWin.show();
      updatePromptWin.focus();
    });
  });
}

async function promptBrowserUpdateIfAvailable(result, trackPreRelease) {
  if (!result || !result.ok || result.upToDate) {
    return { prompted: false, action: 'none' };
  }
  const payload = buildUpdatePromptPayload(result, trackPreRelease);
  const action = await showUpdateAvailablePrompt(payload);
  if (action === 'download' && payload.downloadUrl) {
    await shell.openExternal(payload.downloadUrl);
  }
  return { prompted: true, action };
}

async function maybePromptForStartupUpdate() {
  const settings = mergedSettingsFromDisk();
  const trackPreRelease = settings.trackPreReleaseUpdates === true;
  let result;
  try {
    result = await checkBavariumBrowserUpdates({ prerelease: trackPreRelease });
  } catch (e) {
    console.warn('startup update check:', e);
    return;
  }
  try {
    await promptBrowserUpdateIfAvailable(result, trackPreRelease);
  } catch (e) {
    console.warn('startup update prompt:', e);
  }
}

function scheduleStartupUpdateCheck() {
  if (startupUpdateCheckDone) return;
  startupUpdateCheckDone = true;
  setTimeout(() => {
    void maybePromptForStartupUpdate();
  }, 2000);
}

ipcMain.on('bavarium-shell-ready', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    sendProxyStartupStateToWindow(win);
  }
});

// Save settings
ipcMain.on('save-settings', (event, settings) => {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  let prevKey = '';
  try {
    if (fs.existsSync(settingsPath)) {
      const prev = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      prevKey = String(prev.safeBrowsingApiKey || '').trim();
    }
  } catch (_) {}
  const nextKey = String(settings.safeBrowsingApiKey || '').trim();
  if (prevKey !== nextKey) clearGoogleSafeBrowsingCache();
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  if (settings && settings.proxyEnabled === false) {
    stopProxy();
    currentProxyProcess = null;
  }
  broadcastToAllWindows('settings-updated', settings);
  applyFrameRateSettingsToAll(settings);
});

ipcMain.handle('get-settings', () => mergedSettingsFromDisk());

ipcMain.handle('get-proxy-startup-state', () => getProxyStartupState());

ipcMain.handle('safe-browsing-check-url', async (_event, url) => {
  const hit = await checkSafeBrowsingForNavigation(url);
  return hit || { blocked: false };
});

ipcMain.handle('safe-browsing-allow-host', (_event, url) => {
  getSafeBrowsingService().allowHostForSession(url);
  return { ok: true };
});

ipcMain.handle('safe-browsing-get-status', () => {
  const s = mergedSettingsFromDisk();
  return getSafeBrowsingService().getStatus({
    provider: s.safeBrowsingProvider,
    googleApiKey: s.safeBrowsingApiKey,
  });
});

ipcMain.handle('safe-browsing-refresh-list', async () => {
  const status = await getSafeBrowsingService().refreshBlocklist(true);
  return status;
});

ipcMain.handle('get-display-refresh-rate', () => ({
  hz: getDisplayRefreshRate(),
}));

ipcMain.handle('get-frame-rate-settings', () => resolveFrameRateCap());

ipcMain.handle('get-framework-versions', () => collectFrameworkVersions());

ipcMain.handle('get-about-browser-info', () => getAboutBrowserInfo());

ipcMain.handle('check-browser-updates', () =>
  checkBavariumBrowserUpdates({ prerelease: false })
);

ipcMain.handle('check-prerelease-builds', () =>
  checkBavariumBrowserUpdates({ prerelease: true })
);

ipcMain.handle('show-confirm-prompt', async (_event, payload) => {
  const result = await showConfirmPrompt(payload || {});
  return !!(result && result.proceed);
});

ipcMain.on('confirm-prompt-choice', (_event, payload) => {
  const proceed =
    payload && typeof payload === 'object' && payload.proceed === true;
  const done = pendingConfirmPromptResolve;
  pendingConfirmPromptResolve = null;
  if (done) {
    done({ proceed });
  }
  if (confirmPromptWin && !confirmPromptWin.isDestroyed()) {
    try {
      confirmPromptWin.close();
    } catch (_) {}
  }
});

ipcMain.on('quit-prompt-choice', (_event, payload) => {
  const action =
    payload && typeof payload === 'object' ? payload.action : payload;
  const downloadInBackground =
    payload &&
    typeof payload === 'object' &&
    payload.downloadInBackground === true;
  if (quitPromptWin && !quitPromptWin.isDestroyed()) {
    try {
      quitPromptWin.close();
    } catch (_) {}
  }
  if (pendingQuitPromptResolve) {
    const done = pendingQuitPromptResolve;
    pendingQuitPromptResolve = null;
    if (action === 'leave') {
      done({ proceed: true, downloadInBackground });
    } else {
      done({ proceed: false });
    }
  }
});

ipcMain.on('update-prompt-choice', (_event, action) => {
  if (!pendingUpdatePromptResolve) return;
  const done = pendingUpdatePromptResolve;
  pendingUpdatePromptResolve = null;
  if (updatePromptWin && !updatePromptWin.isDestroyed()) {
    try {
      updatePromptWin.close();
    } catch (_) {}
  }
  done(action === 'download' ? 'download' : 'later');
});

ipcMain.handle('show-browser-update-prompt', async (_event, result) => {
  const settings = mergedSettingsFromDisk();
  const trackPre =
    settings.trackPreReleaseUpdates === true ||
    (result && result.channel === 'prerelease');
  return promptBrowserUpdateIfAvailable(result, trackPre);
});

function formatHostPlatformArchLabel() {
  const archRaw = process.arch || 'unknown';
  const arch =
    archRaw === 'x64' ? 'x64' : archRaw === 'arm64' ? 'arm64' : archRaw;

  if (process.platform === 'win32') {
    const parts = String(os.release() || '').split('.');
    const buildNum = parseInt(parts[2], 10) || 0;
    const name = buildNum >= 22000 ? 'Windows 11' : 'Windows 10';
    return `${name} [${arch}]`;
  }
  if (process.platform === 'darwin') {
    const darwinMajor = parseInt(String(os.release()).split('.')[0], 10) || 0;
    let name = 'macOS';
    if (darwinMajor >= 24) name = 'macOS 15';
    else if (darwinMajor >= 23) name = 'macOS 14';
    else if (darwinMajor >= 22) name = 'macOS 13';
    return `${name} [${arch}]`;
  }
  if (process.platform === 'linux') {
    const distro = (typeof os.type === 'function' && os.type()) || 'Linux';
    return `${distro} [${arch}]`;
  }
  return `${process.platform} [${arch}]`;
}

function getNewtabFooterInfo() {
  const pkg = readAppPackageJson();
  const settings = mergedSettingsFromDisk();
  const version = pkg.bavariumDisplayVersion || '';
  const platform = formatHostPlatformArchLabel();
  let proxyLabel = 'Service Inactive';
  if (
    settings.proxyEnabled !== false &&
    proxyChildIsRunning() &&
    currentProxyListenPort != null
  ) {
    proxyLabel = `localhost:${currentProxyListenPort}`;
  }
  return {
    appName: pkg.productName || APP_DISPLAY_NAME,
    version,
    platform,
    proxyLabel,
    showVersionInfo: settings.homepageShowVersionInfo !== false,
    showSystemInfo: settings.homepageShowSystemInfo !== false,
    showProxyPort: settings.homepageShowProxyPort !== false,
    homepageCustomBackgroundUrl: homepageBackgroundFileUrl(
      settings.homepageCustomBackground
    ),
    homepageShowTiles: settings.homepageShowTiles !== false,
  };
}

ipcMain.handle('get-newtab-footer-info', () => getNewtabFooterInfo());

ipcMain.handle('get-devtools-shortcut-label', () => getDevToolsShortcutLabel());

ipcMain.handle('get-homepage-background-url', () => {
  const s = mergedSettingsFromDisk();
  return homepageBackgroundFileUrl(s.homepageCustomBackground);
});

ipcMain.handle('pick-homepage-background', async () => {
  const parent = dialogParentWindow();
  if (!parent) return null;
  const r = await dialog.showOpenDialog(parent, {
    title: 'Choose homepage background',
    properties: ['openFile'],
    filters: [
      {
        name: 'Images',
        extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
      },
    ],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const src = r.filePaths[0];
  const ext = path.extname(src).toLowerCase() || '.png';
  const userDir = app.getPath('userData');
  try {
    const existing = fs.readdirSync(userDir);
    for (const name of existing) {
      if (name.startsWith(`${HOMEPAGE_BACKGROUND_BASENAME}.`)) {
        fs.unlinkSync(path.join(userDir, name));
      }
    }
  } catch (_) {}
  const destName = `${HOMEPAGE_BACKGROUND_BASENAME}${ext}`;
  const dest = path.join(userDir, destName);
  fs.copyFileSync(src, dest);
  return destName;
});

ipcMain.handle('clear-homepage-background', () => {
  const userDir = app.getPath('userData');
  try {
    const existing = fs.readdirSync(userDir);
    for (const name of existing) {
      if (name.startsWith(`${HOMEPAGE_BACKGROUND_BASENAME}.`)) {
        fs.unlinkSync(path.join(userDir, name));
      }
    }
  } catch (_) {}
  return { ok: true };
});

ipcMain.handle('get-homepage-favorites', () => readHomepageFavoritesFile());

ipcMain.handle('normalize-site-tile-meta', (_event, payload) => {
  const url = payload && payload.url;
  const title = payload && payload.title;
  return normalizeSiteTileMeta(url, title);
});

ipcMain.handle('save-homepage-favorites', (_event, list) => {
  writeHomepageFavoritesFile(list);
  return { ok: true };
});

ipcMain.handle('bavarium-search-suggest', async (_event, payload) => {
  const query = payload && payload.query;
  const searchEngine = (payload && payload.searchEngine) || 'google';
  return fetchSearchSuggestions(query, searchEngine);
});

ipcMain.handle('bavarium-perf-network-stats', () => ({
  downKBs: Math.round(netPerfCounters.downRateBps / 1024),
  upKBs: Math.round(netPerfCounters.upRateBps / 1024),
}));

ipcMain.handle('check-framework-updates', async () => {
  try {
  const settings = mergedSettingsFromDisk();
  const includePrerelease = settings.trackPreReleaseUpdates === true;
  const outdated = await runNpmJson(['outdated', '--json'], __dirname);
  const packages = [];

  if (outdated.ok && outdated.data && typeof outdated.data === 'object') {
    for (const [name, info] of Object.entries(outdated.data)) {
      if (!info || typeof info !== 'object') continue;
      packages.push({
        name,
        current: info.current || '—',
        wanted: info.wanted || '—',
        latest: info.latest || '—',
        location: info.location || '',
        kind: 'outdated',
      });
    }
  }

  const watch = [
    'electron',
    'electron-builder',
    'electron-native-share',
    'rcedit',
  ];
  for (const name of watch) {
    const view = await runNpmJson(
      ['view', name, 'dist-tags', '--json'],
      __dirname
    );
    if (!view.ok || !view.data) continue;
    const tags = view.data;
    const preferredTag = includePrerelease
      ? tags.beta || tags.next || tags.latest
      : tags.latest;
    if (!preferredTag) continue;
    const installed = readInstalledPackageVersion(name, __dirname);
    if (!installed || installed === preferredTag) continue;
    if (packages.some((p) => p.name === name)) continue;
    packages.push({
      name,
      current: installed,
      wanted: preferredTag,
      latest: tags.latest || preferredTag,
      prereleaseTag: includePrerelease ? preferredTag : null,
      kind: includePrerelease ? 'prerelease-channel' : 'registry',
    });
  }

  packages.sort((a, b) => a.name.localeCompare(b.name));
  return {
    ok: true,
    packages,
    includePrerelease,
    npmError: outdated.ok ? null : outdated.error || null,
    checkedAt: Date.now(),
  };
  } catch (e) {
    console.warn('check-framework-updates:', e);
    return {
      ok: false,
      packages: [],
      error: e && e.message ? e.message : String(e),
      checkedAt: Date.now(),
    };
  }
});

ipcMain.handle('bavarium-share-page', async (event, payload) => {
  const url = payload && payload.url;
  const title = payload && payload.title;
  if (!url || typeof url !== 'string') {
    return { ok: false };
  }

  const win =
    BrowserWindow.fromWebContents(event.sender) ||
    BrowserWindow.getFocusedWindow() ||
    getAppBrowserWindows().find((w) => !w.isDestroyed()) ||
    null;
  const anchor = win && !win.isDestroyed() ? win : undefined;
  const shareTitle = title ? String(title) : 'Bavarium Browser';

  if (nativeShare && nativeShare.canShare()) {
    try {
      const result = await nativeShare.share(
        { title: shareTitle, text: shareTitle, url },
        anchor
      );
      return { ok: true, method: result.method || 'native' };
    } catch (err) {
      console.warn('Native share sheet failed:', err);
    }
  }

  if (process.platform === 'darwin' && typeof ShareMenu === 'function') {
    try {
      /** @type {{ urls: string[]; texts?: string[] }} */
      const item = { urls: [url] };
      if (title) item.texts = [shareTitle];
      const shareMenu = new ShareMenu(item);
      shareMenu.popup({ window: anchor });
      return { ok: true, method: 'share' };
    } catch (err) {
      console.warn('ShareMenu fallback failed:', err);
    }
  }

  clipboard.writeText(url);
  return { ok: true, method: 'clipboard' };
});

ipcMain.on('bavarium-alt-menu-visibility', (event, visible) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.setMenuBarVisibility(!!visible);
  }
});

ipcMain.on('bavarium-new-window', () => {
  createWindow();
});

/** Shell pulls a tab into a new browser window (URL + session options). */
ipcMain.on('bavarium-open-tab-in-new-window', (_event, payload) => {
  if (!payload || typeof payload !== 'object') return;
  const win = createWindow();
  const data = {
    url: typeof payload.url === 'string' ? payload.url : '',
    incognito: !!payload.incognito,
    muted: !!payload.muted,
  };
  let sent = false;
  const sendBootstrap = () => {
    if (sent) return;
    sent = true;
    try {
      win.webContents.send('bavarium-bootstrap-tab', data);
    } catch (_) {}
  };
  win.webContents.once('dom-ready', sendBootstrap);
  setTimeout(sendBootstrap, 750);
});

/** Shell closes the window when the last tab is closed (quit confirmation runs on last window). */
ipcMain.on('bavarium-close-shell-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.close();
  }
});

ipcMain.handle('get-browsing-history', () => readHistoryFile());

ipcMain.on('bavarium-guest-site-origin', (_event, payload) => {
  rememberGuestSiteOrigin(payload && payload.webContentsId, payload && payload.origin);
});

ipcMain.on('bavarium-guest-site-page', (_event, payload) => {
  rememberGuestSitePage(payload && payload.webContentsId, payload && payload.page);
});

ipcMain.handle('bavarium-probe-guest-site-origin', async (_event, payload) => {
  const rawId = payload && payload.webContentsId;
  const id = rawId != null ? Number(rawId) : NaN;
  if (!Number.isFinite(id)) return { ok: false, origin: null };
  const wc = webContents.fromId(id);
  if (!wc || wc.isDestroyed()) return { ok: false, origin: null };
  const origin = await resolveGuestSiteOrigin(wc, null);
  return { ok: !!origin, origin: origin || null };
});

ipcMain.handle('bavarium-probe-guest-site-page', async (_event, payload) => {
  const rawId = payload && payload.webContentsId;
  const id = rawId != null ? Number(rawId) : NaN;
  if (!Number.isFinite(id)) return { ok: false, page: null };
  const wc = webContents.fromId(id);
  if (!wc || wc.isDestroyed()) return { ok: false, page: null };
  const refresh = payload && payload.refresh !== false;
  if (!refresh) {
    const cached = guestSitePageByWcId.get(wc.id);
    if (cached && (cached.url || cached.title)) {
      return { ok: true, page: cached };
    }
  }
  const page = await probeGuestSitePage(wc);
  if (page) rememberGuestSitePage(wc.id, page);
  return { ok: !!(page && (page.url || page.title)), page: page || null };
});

function pruneProxyShellOriginsFromStore() {
  const settings = mergedSettingsFromDisk();
  const store = readSitePermissionsStore();
  let changed = false;
  for (const origin of Object.keys(store.origins || {})) {
    if (isProxyShellOrigin(origin, settings)) {
      delete store.origins[origin];
      changed = true;
    }
  }
  if (changed) writeSitePermissionsStore(store);
}

ipcMain.handle('get-site-permissions', () => {
  pruneProxyShellOriginsFromStore();
  const store = readSitePermissionsStore();
  const settings = mergedSettingsFromDisk();
  const origins = Object.keys(store.origins || {})
    .filter((origin) => !isProxyShellOrigin(origin, settings))
    .sort();
  return {
    permissionTypes: SITE_PERMISSION_TYPES,
    sites: origins.map((origin) => ({
      origin,
      hostname: hostnameFromOrigin(origin),
      rules: { ...store.origins[origin] },
    })),
  };
});

ipcMain.handle('set-site-permission', (_event, payload) => {
  const origin = payload && normalizeSiteOrigin(payload.origin || '');
  const permission = payload && payload.permission;
  const rule = payload && payload.rule;
  if (!origin) return { ok: false, error: 'invalid-origin' };
  if (!SITE_PERMISSION_IDS.has(permission)) {
    return { ok: false, error: 'unknown-permission' };
  }
  const result = setSitePermissionRule(origin, permission, rule);
  if (result.ok && rule !== 'ask') ensureSiteOriginRecorded(origin);
  return result;
});

ipcMain.handle('add-site-permission-origin', (_event, payload) => {
  const origin = payload && normalizeSiteOrigin(payload.origin || '');
  if (!origin) return { ok: false, error: 'invalid-origin' };
  ensureSiteOriginRecorded(origin);
  return { ok: true, origin };
});

ipcMain.handle('remove-site-permissions', (_event, payload) => {
  const origin = payload && normalizeSiteOrigin(payload.origin || '');
  if (!origin) return { ok: false, error: 'invalid-origin' };
  const store = readSitePermissionsStore();
  delete store.origins[origin];
  writeSitePermissionsStore(store);
  return { ok: true };
});

ipcMain.handle('clear-all-site-permissions', () => {
  clearAllSitePermissionsStore();
  return { ok: true };
});

ipcMain.handle('clear-browsing-history', () => {
  writeHistoryFile([]);
  return true;
});

ipcMain.handle('delete-browsing-history-item', (event, index) => {
  const list = readHistoryFile();
  if (typeof index === 'number' && index >= 0 && index < list.length) {
    list.splice(index, 1);
    writeHistoryFile(list);
  }
  return readHistoryFile();
});

ipcMain.on('history-append', (event, entry) => {
  if (loadSettings().historyEnabled === false) return;
  if (!entry || !entry.url) return;
  let list = readHistoryFile();
  list = list.filter((h) => h.url !== entry.url);
  list.unshift({
    url: entry.url,
    title: entry.title || entry.url,
    ts: entry.ts || Date.now(),
  });
  writeHistoryFile(list.slice(0, HISTORY_LIMIT));
});

ipcMain.on('history-update-title', (event, payload) => {
  if (loadSettings().historyEnabled === false) return;
  if (!payload || !payload.url) return;
  const list = readHistoryFile();
  const i = list.findIndex((h) => h.url === payload.url);
  if (i !== -1) {
    list[i].title = payload.title || list[i].title;
    writeHistoryFile(list);
  }
});

ipcMain.handle('get-download-records', () => readDownloadsFile());

ipcMain.handle('get-downloads-shelf', () => {
  const active = [];
  for (const item of activeDownloadItems) {
    const row = summarizeActiveDownloadItem(item);
    if (row) active.push(row);
  }
  const recent = readDownloadsFile()
    .slice(0, 5)
    .map((d) => ({ ...d, active: false }));
  return { active, recent };
});

ipcMain.handle('clear-download-records', () => {
  writeDownloadsFile([]);
  broadcastToAllWindows('downloads-updated');
  return true;
});

/**
 * Browsing history file, download log, site data (cookies, storage, cache, SW) for
 * the webview partition, plus notifies the shell to clear bookmarks / reload tabs.
 *
 * Session clear must not run while ipcRenderer.invoke() from the settings webview is
 * still awaiting: clearData/clearCache use internal IPC that needs the renderer free.
 * Resolve the handle immediately, then clear on the next event-loop turn.
 */
ipcMain.handle('bavarium-clear-all-browser-data', () => {
  writeHistoryFile([]);
  writeDownloadsFile([]);
  writeHomepageFavoritesFile([]);
  clearAllSitePermissionsStore();

  setImmediate(() => {
    const persist = session.fromPartition('persist:bavarium');
    const incog = session.fromPartition(INCOGNITO_PARTITION);
    Promise.all([
      persist.clearCache(),
      persist.clearData({}),
      incog.clearCache(),
      incog.clearData({}),
    ])
      .catch((e) => {
        console.error('bavarium-clear-all-browser-data session:', e);
      })
      .finally(() => {
        broadcastToAllWindows('browser-data-cleared');
        broadcastToAllWindows('downloads-updated');
      });
  });

  return { ok: true };
});

ipcMain.handle('reveal-download', (event, filePath) => {
  if (filePath) shell.showItemInFolder(filePath);
});

ipcMain.handle('bavarium-open-devtools', (_event, payload) => {
  const rawGuestId = payload && payload.webContentsId;
  const guestId = rawGuestId != null ? Number(rawGuestId) : NaN;
  if (!Number.isFinite(guestId)) {
    return { ok: false, error: 'invalid-id' };
  }
  const wc = webContents.fromId(guestId);
  if (!wc || wc.isDestroyed()) {
    return { ok: false, error: 'no-web-contents' };
  }
  if (payload && payload.close) {
    try {
      if (wc.isDevToolsOpened()) wc.closeDevTools();
    } catch (e) {
      console.warn('closeDevTools:', e);
    }
    return { ok: true, closed: true };
  }

  const rawHostId = payload && payload.devtoolsHostWebContentsId;
  const hostId = rawHostId != null ? Number(rawHostId) : NaN;
  const devHost = Number.isFinite(hostId) ? webContents.fromId(hostId) : null;

  try {
    if (devHost && !devHost.isDestroyed() && typeof wc.setDevToolsWebContents === 'function') {
      if (wc.isDevToolsOpened()) {
        wc.closeDevTools();
      }
      wc.setDevToolsWebContents(devHost);
      wc.openDevTools({ activate: true });
      return { ok: true, embedded: true };
    }
    if (wc.isDevToolsOpened()) {
      const dt = wc.devToolsWebContents;
      if (dt && !dt.isDestroyed()) {
        try {
          dt.focus();
        } catch (_) {
          const devWin = BrowserWindow.fromWebContents(dt);
          if (devWin && !devWin.isDestroyed()) devWin.focus();
        }
      }
      return { ok: true, alreadyOpen: true };
    }
    wc.openDevTools({ mode: 'detach', activate: true });
    return { ok: true, detached: true };
  } catch (e) {
    console.warn('openDevTools:', e);
    try {
      wc.openDevTools({ mode: 'detach', activate: true });
      return { ok: true, detached: true };
    } catch (e2) {
      return { ok: false, error: String(e2 && e2.message ? e2.message : e2) };
    }
  }
});

ipcMain.handle('bavarium-save-page-as', async (event, payload) => {
  const rawId = payload && payload.webContentsId;
  const id = rawId != null ? Number(rawId) : NaN;
  if (!Number.isFinite(id)) {
    return { ok: false, error: 'invalid-id' };
  }
  const wc = webContents.fromId(id);
  if (!wc || wc.isDestroyed()) {
    return { ok: false, error: 'no-web-contents' };
  }
  const parent = BrowserWindow.fromWebContents(event.sender);
  let defaultName = 'page.html';
  try {
    const t = (wc.getTitle() || '').trim();
    if (t) {
      const safe = t.replace(/[/\\?%*:|"<>]/g, '').slice(0, 100);
      if (safe) defaultName = `${safe}.html`;
    }
  } catch (_) {}
  const r = await dialog.showSaveDialog(parent || dialogParentWindow(), {
    title: 'Save Page As',
    defaultPath: defaultName,
    filters: [
      { name: 'Web Page, Complete', extensions: ['html', 'htm'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePath) {
    return { ok: false, canceled: true };
  }
  let savePath = r.filePath;
  if (!/\.html?$/i.test(savePath)) {
    savePath += '.html';
  }
  try {
    await wc.savePage(savePath, 'HTMLComplete');
    if (!guestWebviewIsIncognito(wc)) {
      let pageUrl = '';
      try {
        pageUrl = wc.getURL() || '';
      } catch (_) {}
      appendDownloadRecord({
        name: path.basename(savePath),
        path: savePath,
        state: 'completed',
        url: pageUrl,
      });
    }
    return { ok: true, path: savePath };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { ok: false, error: msg };
  }
});

ipcMain.handle('select-download-folder', async () => {
  const parent = dialogParentWindow();
  if (!parent) return null;
  const r = await dialog.showOpenDialog(parent, {
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle('get-default-downloads-path', () => app.getPath('downloads'));

/**
 * Returns whether something is already listening on 127.0.0.1:port (EADDRINUSE when we try to bind).
 */
/**
 * True when something accepts TCP connections on 127.0.0.1:port (proxy already listening).
 */
function checkPortInUse(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      try {
        socket.destroy();
      } catch (_) {}
      resolve(result);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done({ inUse: true }));
    socket.once('timeout', () => done({ inUse: false }));
    socket.once('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        done({ inUse: false });
        return;
      }
      done({ inUse: false, bindError: err.message });
    });
    socket.connect(port, '127.0.0.1');
  });
}

ipcMain.handle('check-proxy-port', async (event, payload) => {
  const portInput = payload && payload.port != null ? payload.port : '';
  const whichRaw = payload && payload.which;
  const which = whichRaw === 'sj' ? 'sj' : 'uv';
  const port = parseInt(String(portInput).trim(), 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return {
      ok: false,
      message: 'Enter a port number between 1 and 65535.',
    };
  }
  const result = await checkPortInUse(port);
  if (result.bindError) {
    return {
      ok: true,
      port,
      inUse: null,
      isOurProxy: false,
      message: `Could not check port: ${result.bindError}`,
    };
  }
  const settings = loadSettings();
  const pType = normalizeProxyTypeFromDisk(settings.proxyType || 'ultraviolet');
  const uvDisk = parseInt(String(settings.uvPort || '8080'), 10);
  const sjDisk = parseInt(String(settings.scramjetPort || '3000'), 10);
  let isOurProxy = false;
  if (result.inUse && proxyChildIsRunning() && port === currentProxyListenPort) {
    if (which === 'uv' && currentProxyKind === 'ultraviolet') {
      isOurProxy = true;
    }
    if (which === 'sj' && currentProxyKind === 'scramjet') {
      isOurProxy = true;
    }
  }

  let suggestedPort = null;
  if (result.inUse && !isOurProxy) {
    suggestedPort = await findAvailableListenPort(port);
  }

  return {
    ok: true,
    port,
    inUse: result.inUse,
    isOurProxy,
    suggestedPort,
    configuredPort: which === 'uv' ? uvDisk : sjDisk,
  };
});

ipcMain.handle('find-available-proxy-port', async (_event, payload) => {
  const portInput = payload && payload.port != null ? payload.port : '';
  const port = parseInt(String(portInput).trim(), 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return { ok: false, message: 'Invalid port.' };
  }
  const available = await findAvailableListenPort(port);
  return { ok: true, port, available };
});

function dispatchBavariumProtocolUrl(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('bavarium://')) {
    return;
  }
  for (const w of getAppBrowserWindows()) {
    if (w.isDestroyed()) continue;
    try {
      w.webContents.send('bavarium-protocol-navigate', url);
      if (w.isMinimized()) w.restore();
      w.focus();
      return;
    } catch (_) {}
  }
}

function registerBavariumProtocolHandler() {
  if (protocol.isProtocolHandled('bavarium')) {
    return;
  }
  protocol.handle('bavarium', (request) => {
    dispatchBavariumProtocolUrl(request.url);
    return new Response('<!DOCTYPE html><html><head></head><body></body></html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  });
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('bavarium', process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient('bavarium');
  }
}

function bavariumUrlFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  return argv.find((a) => typeof a === 'string' && a.startsWith('bavarium://')) || null;
}

if (gotTheLock) {
  app.on('second-instance', (_event, argv) => {
    const deepLink = bavariumUrlFromArgv(argv);
    if (deepLink) {
      dispatchBavariumProtocolUrl(deepLink);
    }
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      const w =
        BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      if (w && !w.isDestroyed()) {
        if (w.isMinimized()) w.restore();
        w.focus();
      }
    }
  });

  app.whenReady().then(() => {
    registerBavariumProtocolHandler();
    pendingBavariumLaunchUrl = bavariumUrlFromArgv(process.argv);
    const iconPath = getAppIconPath();
    if (iconPath && process.platform === 'darwin' && app.dock) {
      try {
        app.dock.setIcon(iconPath);
      } catch (_) {}
    }
    registerGuestWebviewContextMenu();
    setupBavariumSitePermissionHandlers();
    setupNetworkPerfCounters(session.fromPartition(BAVARIUM_WEB_PARTITION));
    setInterval(tickNetPerfRates, 1000);
    setupDownloadSession();
    getSafeBrowsingService();
    void startSelectedProxy();
    // Never block the UI on the proxy binding: in packaged builds the child can fail
    // (path, quarantine, port) and waitForPort would retry forever with no window shown.
    createWindow();
    createApplicationMenu();
    applyFrameRateSettingsToAll(mergedSettingsFromDisk());
    scheduleStartupUpdateCheck();
  });

  app.on('window-all-closed', () => {
    if (quitWhenDownloadsComplete) return;
    app.quit();
  });

  app.on('before-quit', (e) => {
    if (quitConfirmed) return;
    e.preventDefault();
    void requestQuitConfirmation().then((result) => {
      if (!result || !result.proceed) return;
      void finalizeQuitFromPrompt({
        downloadInBackground: !!result.downloadInBackground,
      });
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  app.on('will-quit', () => {
    quitConfirmed = true;
    stopProxy();
  });
}