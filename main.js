// === UPDATED MAIN.JS WITH LIVE PROXY SWITCHING ===
const { app, BrowserWindow, ipcMain, dialog, session, shell, Menu, webContents, clipboard, ShareMenu } = require('electron');

/** Second process exits; first can reopen a window via second-instance (Windows/Linux). */
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

const INCOGNITO_PARTITION = 'incognito';

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
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');

const HISTORY_LIMIT = 500;
const DOWNLOAD_RECORD_LIMIT = 200;

let currentProxyProcess = null;

const NODE = process.execPath;

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

  child.on('exit', (code, signal) => {
    if (code != null && code !== 0) {
      console.error(`Proxy (${type}) exited with code ${code}`, signal || '');
    }
  });

  return child;
}

function stopProxy() {
  if (currentProxyProcess) {
    console.log('Stopping proxy...');
    currentProxyProcess.kill();
    currentProxyProcess = null;
  }
}

function waitForPort(port, callback) {
  const client = new net.Socket();

  client.setTimeout(1000);

  client.once('error', () => {
    setTimeout(() => waitForPort(port, callback), 300);
  });

  client.once('timeout', () => {
    client.destroy();
    setTimeout(() => waitForPort(port, callback), 300);
  });

  client.connect(port, '127.0.0.1', () => {
    client.end();
    callback();
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
  return h || 'google';
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
    askBeforeDownload: s.askBeforeDownload !== false,
    downloadPath: s.downloadPath || '',
  };
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
    if (!u.pathname.endsWith('settings.html')) return null;
    const h = (u.hash || '').replace(/^#/, '') || 'settings';
    const map = {
      settings: 'bavarium://settings',
      proxy: 'bavarium://proxy',
      browsing: 'bavarium://browsing',
      history: 'bavarium://history',
      privacy: 'bavarium://privacy',
      downloads: 'bavarium://downloads',
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

function guestUrlIsProxyTunnelMenu(url, settings) {
  if (!url || !settings || settings.proxyEnabled === false) return false;
  if (settings.proxyType !== 'ultraviolet' && settings.proxyType !== 'scramjet') {
    return false;
  }
  const loc = parseLocalhostPortMenu(url);
  if (!loc) return false;
  const expected =
    settings.proxyType === 'ultraviolet'
      ? parseInt(String(settings.uvPort ?? 8080), 10)
      : parseInt(String(settings.scramjetPort ?? 3000), 10);
  if (loc.port !== expected) return false;
  try {
    const u = new URL(url);
    if (u.searchParams.has('url')) return true;
    if (settings.proxyType === 'scramjet' && /\/scramjet\//i.test(u.pathname)) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
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

function registerGuestWebviewContextMenu() {
  app.on('web-contents-created', (_event, wc) => {
    if (wc.getType() !== 'webview') return;
    wc.setWindowOpenHandler((details) => {
      const openUrl = details.url;
      if (
        !openUrl ||
        openUrl === 'about:blank' ||
        openUrl.startsWith('javascript:') ||
        openUrl.startsWith('data:')
      ) {
        return { action: 'deny' };
      }
      const host = wc.hostWebContents;
      if (host && !host.isDestroyed()) {
        const background = details.disposition === 'background-tab';
        host.send('bavarium-new-tab-with-url', {
          url: openUrl,
          background,
          incognito: guestWebviewIsIncognito(wc),
        });
      }
      return { action: 'deny' };
    });
    wc.on('context-menu', (event, params) => {
      event.preventDefault();
      const settings = mergedSettingsFromDisk();
      let rawUrl = '';
      try {
        rawUrl = wc.getURL() || '';
      } catch (_) {}
      const displayUrl = cleanUrlForContextMenu(rawUrl);
      const editFlags = params.editFlags || {};
      const win = browserWindowForGuestWebContents(wc);

      /** @type {Electron.MenuItemConstructorOptions[]} */
      const template = [
        {
          label: 'Copy',
          enabled: !!editFlags.canCopy,
          click: () => {
            try {
              wc.copy();
            } catch (_) {}
          },
        },
        {
          label: 'Paste',
          enabled: !!editFlags.canPaste,
          click: () => {
            try {
              wc.paste();
            } catch (_) {}
          },
        },
        { type: 'separator' },
        {
          label: 'Copy URL',
          enabled: !!displayUrl,
          click: () => clipboard.writeText(displayUrl),
        },
        {
          label: 'Copy proxied URL',
          enabled: guestUrlIsProxyTunnelMenu(rawUrl, settings),
          click: () => clipboard.writeText(rawUrl),
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
          click: async () => {
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
            } catch (e) {
              console.warn('Save page:', e);
            }
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
        {
          label: 'Inspect Element',
          click: () => {
            try {
              wc.inspectElement(params.x, params.y);
            } catch (_) {}
          },
        }
      );

      const menu = Menu.buildFromTemplate(template);
      menu.popup({
        window: win || undefined,
        x: params.x,
        y: params.y,
      });
    });
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

function setupDownloadHandlersForPartition(partition, recordInDownloadManager) {
  const ses = session.fromPartition(partition);
  ses.on('will-download', (event, item) => {
    const s = loadSettings();
    const ask = s.askBeforeDownload !== false;
    const baseDir =
      (s.downloadPath && String(s.downloadPath).trim()) ||
      app.getPath('downloads');
    const fileName = item.getFilename();

    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    item.on('done', (_e, state) => {
      if (!recordInDownloadManager) {
        return;
      }
      const list = readDownloadsFile();
      const savedPath = item.getSavePath() || '';
      list.unshift({
        id,
        name: fileName,
        path: savedPath,
        state,
        ts: Date.now(),
      });
      writeDownloadsFile(list.slice(0, DOWNLOAD_RECORD_LIMIT));
      broadcastToAllWindows('downloads-updated');
    });

    if (ask) {
      /*
       * Do not call preventDefault() before a path exists: with an async dialog,
       * Electron cancels the download. Let the default flow run and only customize
       * the save dialog via setSaveDialogOptions.
       */
      item.setSaveDialogOptions({
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

function startSelectedProxy() {
  const settings = loadSettings();

  stopProxy();
  currentProxyProcess = null;

  if (settings.proxyEnabled === false) {
    return null;
  }

  const proxyType = normalizeProxyTypeFromDisk(settings.proxyType || 'ultraviolet');

  const port = proxyType === 'ultraviolet'
    ? (settings.uvPort || '8080')
    : (settings.scramjetPort || '3000');

  currentProxyProcess = startProxy(proxyType, port);

  return port;
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
  currentProxyProcess = null;

  if (settings.proxyEnabled === false) {
    broadcastToAllWindows('settings-updated', settings);
    return;
  }

  const proxyType = normalizeProxyTypeFromDisk(settings.proxyType || 'ultraviolet');
  const port = proxyType === 'ultraviolet'
    ? settings.uvPort || '8080'
    : settings.scramjetPort || '3000';

  currentProxyProcess = startProxy(proxyType, port);

  waitForPort(port, () => {
    broadcastToAllWindows('settings-updated', settings);
    broadcastToAllWindows('proxy-switched');
  });
});

// Save settings
ipcMain.on('save-settings', (event, settings) => {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  if (settings && settings.proxyEnabled === false) {
    stopProxy();
    currentProxyProcess = null;
  }
  broadcastToAllWindows('settings-updated', settings);
});

ipcMain.handle('get-settings', () => mergedSettingsFromDisk());

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

/** Shell closes the window when the last tab is closed; app may keep running (proxy stays up). */
ipcMain.on('bavarium-close-shell-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.close();
  }
});

ipcMain.handle('get-browsing-history', () => readHistoryFile());

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
function checkPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      try {
        server.close();
      } catch (_) {}
      if (err.code === 'EADDRINUSE') resolve({ inUse: true });
      else resolve({ inUse: false, bindError: err.message });
    });
    server.listen({ port, host: '127.0.0.1' }, () => {
      server.close(() => resolve({ inUse: false }));
    });
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
  if (result.inUse) {
    if (which === 'uv' && pType === 'ultraviolet' && port === uvDisk) {
      isOurProxy = true;
    }
    if (which === 'sj' && pType === 'scramjet' && port === sjDisk) {
      isOurProxy = true;
    }
  }
  return {
    ok: true,
    port,
    inUse: result.inUse,
    isOurProxy,
  };
});

if (gotTheLock) {
  app.on('second-instance', () => {
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
    const iconPath = getAppIconPath();
    if (iconPath && process.platform === 'darwin' && app.dock) {
      try {
        app.dock.setIcon(iconPath);
      } catch (_) {}
    }
    registerGuestWebviewContextMenu();
    setupDownloadSession();
    startSelectedProxy();
    // Never block the UI on the proxy binding: in packaged builds the child can fail
    // (path, quarantine, port) and waitForPort would retry forever with no window shown.
    createWindow();
    createApplicationMenu();
  });

  app.on('window-all-closed', () => {
    // Do not quit: local proxy keeps running until File → Quit / Cmd+Q (macOS) exits the app.
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  app.on('will-quit', () => {
    stopProxy();
  });
}