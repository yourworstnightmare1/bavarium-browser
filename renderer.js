let tabs = [];
let currentTab = null;
let tabId = 0;

const { ipcRenderer, webContents } = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

let pendingBootstrapTab = null;

function getAppIconFileUrlForTab() {
  try {
    const p = path.join(__dirname, "build", "icon.png");
    if (fs.existsSync(p)) return pathToFileURL(p).href;
  } catch (_) {}
  return "";
}

function localProxyBaseUrl(settings) {
  const port =
    settings.proxyType === "scramjet"
      ? settings.scramjetPort || 3000
      : settings.uvPort || 8080;
  return `http://localhost:${port}/`;
}

/** Route remote http(s) URLs through the selected local proxy (same rules as the address bar). */
function wrapUrlForProxyIfNeeded(url, settings) {
  if (!url || typeof url !== "string") return url;
  if (url.startsWith("bavarium://") || url.startsWith("file://")) return url;
  if (settings.proxyEnabled === false) return url;

  try {
    const u = new URL(url);
    const selPort = parseInt(
      String(
        settings.proxyType === "scramjet"
          ? settings.scramjetPort || 3000
          : settings.uvPort || 8080
      ),
      10
    );
    if (
      (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
      parseInt(u.port || "80", 10) === selPort &&
      u.searchParams.has("url")
    ) {
      return url;
    }
  } catch {
    /* ignore */
  }

  const isLocal = url.includes("localhost") || url.startsWith("file://");
  if (
    !isLocal &&
    (settings.proxyType === "ultraviolet" || settings.proxyType === "scramjet")
  ) {
    const port =
      settings.proxyType === "ultraviolet"
        ? settings.uvPort || 8080
        : settings.scramjetPort || 3000;
    return `http://localhost:${port}/?url=${encodeURIComponent(url)}`;
  }
  return url;
}

function parseLocalhostPort(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
      return null;
    }
    const port = u.port
      ? parseInt(u.port, 10)
      : u.protocol === "https:"
        ? 443
        : 80;
    if (!Number.isFinite(port)) return null;
    return { port, pathname: u.pathname || "/" };
  } catch {
    return null;
  }
}

/**
 * True when the URL is the root / index page on the local port for the proxy
 * that is not currently selected (e.g. Scramjet port while Ultraviolet is selected).
 */
function isOpposingProxyHomepageUrl(url, settings) {
  const pt = settings.proxyType;
  if (pt !== "ultraviolet" && pt !== "scramjet") return false;

  const uv = parseInt(String(settings.uvPort ?? 8080), 10);
  const sj = parseInt(String(settings.scramjetPort ?? 3000), 10);
  if (!Number.isFinite(uv) || !Number.isFinite(sj)) return false;

  const selectedPort = pt === "ultraviolet" ? uv : sj;
  const opposingPort = pt === "ultraviolet" ? sj : uv;
  if (opposingPort === selectedPort) return false;

  const loc = parseLocalhostPort(url);
  if (!loc || loc.port !== opposingPort) return false;

  const path = (loc.pathname || "/").replace(/\/+$/, "") || "/";
  const low = path.toLowerCase();
  return low === "/" || low === "/index.html" || low === "/index.htm";
}

function notifyOpposingProxyHomepageBlocked(settings) {
  const selected =
    settings.proxyType === "ultraviolet" ? "Ultraviolet" : "Scramjet";
  const other = settings.proxyType === "ultraviolet" ? "Scramjet" : "Ultraviolet";
  alert(
    `${other}'s local home page is not available while ${selected} is selected. ` +
      `Change proxy type in Settings if you need ${other}, or use ${selected}'s port instead.`
  );
}

function isBavariumNewTabUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "bavarium:") return false;
    const host = (u.hostname || "").toLowerCase();
    const seg = (u.pathname || "").replace(/^\//, "").split("/").filter(Boolean)[0];
    const frag = (u.hash || "").replace(/^#/, "");
    if (host === "newtab") return true;
    if (seg === "newtab") return true;
    if (frag === "newtab") return true;
    return false;
  } catch {
    return false;
  }
}

function tabEntryForView(view) {
  return tabs.find((t) => t.view === view);
}

function viewIsIncognito(view) {
  const te = tabEntryForView(view);
  return !!(te && te.incognito);
}

/** Native tooltip on the tab strip: full page title, incognito explanation. */
function refreshTabTooltip(te) {
  if (!te || !te.tab) return;
  let pageName = (te.fullTitle && te.fullTitle.trim()) || "";
  if (!pageName) {
    try {
      if (te.view && te.view.getURL) {
        const u = te.view.getURL();
        if (u) pageName = cleanUrl(u);
      }
    } catch (_) {}
  }
  if (!pageName) {
    pageName = te.incognito ? "Incognito" : "New Tab";
  }
  if (te.incognito) {
    te.tab.title =
      "Incognito tab — browsing history and download log are not saved for this tab.\n\nPage: " +
      pageName;
  } else {
    te.tab.title = pageName;
  }
}

const TAB_LABEL_MAX = 22;

function setTabFaviconImg(faviconImg, view, navUrl, faviconUrlList) {
  if (!faviconImg) return;

  let u = navUrl;
  if ((u == null || u === "") && view && view.getURL) {
    try {
      u = view.getURL();
    } catch (_) {}
  }
  if (u) {
    const c = cleanUrl(u);
    if (c.startsWith("bavarium://")) {
      const appIcon = getAppIconFileUrlForTab();
      if (appIcon) {
        faviconImg.src = appIcon;
        faviconImg.style.display = "";
      } else {
        faviconImg.removeAttribute("src");
        faviconImg.style.display = "none";
      }
      return;
    }
  }

  let src = "";
  if (faviconUrlList && faviconUrlList.length > 0) {
    const first = faviconUrlList[0];
    if (first && typeof first === "string") src = first.trim();
  }
  if (!src) {
    if (u) {
      const c = cleanUrl(u);
      if (c.startsWith("file://")) {
        faviconImg.removeAttribute("src");
        faviconImg.style.display = "none";
        return;
      }
      try {
        const abs =
          c.startsWith("http://") || c.startsWith("https://")
            ? c
            : `https://${c}`;
        const parsed = new URL(abs);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          const host = parsed.hostname;
          if (host && host !== "localhost" && host !== "127.0.0.1") {
            src = `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(
              host
            )}`;
          }
        }
      } catch (_) {}
    }
  }
  if (src) {
    faviconImg.src = src;
    faviconImg.style.display = "";
  } else {
    faviconImg.removeAttribute("src");
    faviconImg.style.display = "none";
  }
}

/**
 * Short label on the tab strip.
 * @param preferExistingTitle - for in-page navigations, use current getTitle() before URL
 *   so SPAs keep showing the site title instead of a raw proxy URL.
 */
function applyTabStripLabel(
  view,
  titleEl,
  incognito,
  navUrl,
  preferredTitle,
  preferExistingTitle
) {
  let label = (preferredTitle && String(preferredTitle).trim()) || "";

  if (!label && preferExistingTitle) {
    try {
      if (view && view.getTitle) label = (view.getTitle() || "").trim();
    } catch (_) {}
  }

  if (!label && navUrl != null && navUrl !== "") {
    const c = cleanUrl(navUrl);
    label = (c && c.trim()) || navUrl;
  }

  if (!label) {
    try {
      if (view && view.getTitle) label = (view.getTitle() || "").trim();
    } catch (_) {}
  }

  if (!label) {
    let url = "";
    try {
      if (view && view.getURL) url = view.getURL() || "";
    } catch (_) {}
    if (url) {
      const c = cleanUrl(url);
      label = (c && c.trim()) || url;
    }
  }

  const short =
    label.length > TAB_LABEL_MAX
      ? `${label.slice(0, TAB_LABEL_MAX - 1)}…`
      : label;
  titleEl.innerText = short || (incognito ? "Incognito" : "New Tab");
}

function newTab(url = null, options = {}) {
  const incognito = !!(options && options.incognito);
  const openInBackground = !!(options && options.background);
  const settings = getSettings();

  if (url && isBavariumNewTabUrl(url)) {
    url = null;
  }

  if (!url) {
    switch (settings.homepage) {
      case "duckduckgo":
        url = "https://duckduckgo.com";
        break;

      case "ultraviolet":
      case "scramjet":
        url = localProxyBaseUrl(settings);
        break;

      default:
        url = "https://www.google.com";
    }
  }

  if (url && isOpposingProxyHomepageUrl(url, settings)) {
    notifyOpposingProxyHomepageBlocked(settings);
    url = "https://www.google.com";
  }

  if (url && !url.startsWith("bavarium://")) {
    url = wrapUrlForProxyIfNeeded(url, settings);
  }

  const id = tabId++;

  const tab = document.createElement("div");
  tab.className = incognito ? "tab incognito" : "tab";

  const faviconImg = document.createElement("img");
  faviconImg.className = "tab-favicon";
  faviconImg.alt = "";
  faviconImg.width = 16;
  faviconImg.height = 16;
  faviconImg.decoding = "async";
  faviconImg.style.display = "none";

  const title = document.createElement("span");
  title.innerText = incognito ? "Incognito" : "New Tab";

  const closeBtn = document.createElement("span");
  closeBtn.className = "tab-close";
  closeBtn.innerText = " ✕";
  closeBtn.style.cursor = "pointer";
  closeBtn.title = "Close tab";
  closeBtn.setAttribute("aria-label", "Close tab");
  closeBtn.setAttribute("draggable", "false");
  closeBtn.onclick = (e) => {
    e.stopPropagation();
    closeTab(id);
  };

  tab.appendChild(faviconImg);
  tab.appendChild(title);
  tab.appendChild(closeBtn);
  tab.draggable = true;
  attachTabStripInteractions(tab, id);

  document.getElementById("tabs").appendChild(tab);

  const view = document.createElement("webview");
  view.setAttribute("partition", incognito ? "incognito" : "persist:bavarium");
  view.setAttribute(
    "webpreferences",
    "nodeIntegration=yes,contextIsolation=no,sandbox=no"
  );
  view.style.display = "none";

  view.addEventListener("dom-ready", () => {
    try {
      const id = view.getWebContentsId();
      const wc = webContents.fromId(id);
      if (!wc || wc.isDestroyed()) return;
      if (wc.__bavariumInternalNavHook) return;
      wc.__bavariumInternalNavHook = true;
      wc.on("will-navigate", (event, legacyUrl) => {
        const navUrl =
          (typeof legacyUrl === "string" && legacyUrl) ||
          (event && typeof event.url === "string" ? event.url : "") ||
          "";
        if (navUrl.startsWith("bavarium://")) {
          event.preventDefault();
          handleInternal(navUrl, view);
        }
      });
      if (typeof wc.setWindowOpenHandler === "function") {
        wc.setWindowOpenHandler((details) => {
          const u = details.url || "";
          if (u.startsWith("bavarium://")) {
            handleInternal(u, view);
            return { action: "deny" };
          }
          return { action: "allow" };
        });
      }
    } catch (_) {}
  });

  view.addEventListener("page-favicon-updated", (e) => {
    const te0 = tabEntryForView(view);
    if (te0 && te0.faviconImg) {
      const urls = e.favicons && e.favicons.length ? e.favicons : null;
      setTabFaviconImg(te0.faviconImg, view, null, urls);
    }
  });

  view.addEventListener("page-title-updated", (e) => {
    const te0 = tabEntryForView(view);
    if (te0) {
      te0.fullTitle = e.title || "";
      refreshTabTooltip(te0);
    }
    applyTabStripLabel(view, title, incognito, null, e.title, false);
    if (viewIsIncognito(view)) return;
    const s = getSettings();
    if (s.historyEnabled === false) return;
    const u = cleanUrl(view.getURL());
    if (!shouldRecordHistoryUrl(u)) return;
    ipcRenderer.send("history-update-title", { url: u, title: e.title });
  });

  view.addEventListener("did-navigate", (e) => {
    const te0 = tabEntryForView(view);
    if (te0) {
      te0.fullTitle = "";
      refreshTabTooltip(te0);
    }
    if (te0 && te0.faviconImg) {
      setTabFaviconImg(te0.faviconImg, view, e.url, null);
    }
    applyTabStripLabel(view, title, incognito, e.url, null, false);
    if (currentTab && currentTab.view === view) {
      document.getElementById("url").value = cleanUrl(e.url);
    }
    appendHistoryForNavigation(view, e.url);
  });

  view.addEventListener("did-navigate-in-page", (e) => {
    const te0 = tabEntryForView(view);
    if (te0) refreshTabTooltip(te0);
    if (te0 && te0.faviconImg) {
      setTabFaviconImg(te0.faviconImg, view, e.url, null);
    }
    applyTabStripLabel(view, title, incognito, e.url, null, true);
    if (currentTab && currentTab.view === view) {
      document.getElementById("url").value = cleanUrl(e.url);
    }
    appendHistoryForNavigation(view, e.url);
  });

  view.addEventListener("did-finish-load", () => {
    const te0 = tabEntryForView(view);
    let t = "";
    try {
      if (view.getTitle) t = (view.getTitle() || "").trim();
    } catch (_) {}
    if (t) {
      if (te0) {
        te0.fullTitle = t;
        refreshTabTooltip(te0);
      }
      applyTabStripLabel(view, title, incognito, null, t, false);
    } else {
      let u = "";
      try {
        u = view.getURL() || "";
      } catch (_) {}
      applyTabStripLabel(view, title, incognito, u || null, null, false);
    }
  });

  view.addEventListener("found-in-page", (e) => {
    const st = document.getElementById("findStatus");
    if (!st) return;
    const { activeMatchOrdinal, matches } = e.result;
    if (!matches) st.textContent = "";
    else st.textContent = `${activeMatchOrdinal} / ${matches}`;
  });

  document.getElementById("views").appendChild(view);

  const tabEntry = {
    id,
    tab,
    view,
    incognito,
    fullTitle: "",
    faviconImg,
  };
  tabs.push(tabEntry);
  refreshTabTooltip(tabEntry);
  if (!openInBackground) {
    switchTab(id);
  }

  // 🔥 FIX: handle internal URLs like settings
  if (url.startsWith("bavarium://")) {
    handleInternal(url, view);
  } else {
    view.src = url;
  }
}


function closeFindInPage() {
  document.body.classList.remove("find-open");
  const bar = document.getElementById("findBar");
  if (bar) bar.style.display = "none";
  const st = document.getElementById("findStatus");
  if (st) st.textContent = "";
  if (currentTab && currentTab.view && currentTab.view.stopFindInPage) {
    try {
      currentTab.view.stopFindInPage("clearSelection");
    } catch (_) {}
  }
}

function openFindInPage() {
  const bar = document.getElementById("findBar");
  const inp = document.getElementById("findInput");
  if (!bar || !inp) return;
  document.body.classList.add("find-open");
  bar.style.display = "flex";
  inp.focus();
  inp.select();
  const q = inp.value.trim();
  if (q && currentTab && currentTab.view && currentTab.view.findInPage) {
    currentTab.view.findInPage(q, { forward: true });
  }
}

function findInPageSchedule() {
  const v = currentTab && currentTab.view;
  const inp = document.getElementById("findInput");
  if (!v || !inp || !v.findInPage) return;
  const q = inp.value;
  if (!q) {
    try {
      v.stopFindInPage("clearSelection");
    } catch (_) {}
    const st = document.getElementById("findStatus");
    if (st) st.textContent = "";
    return;
  }
  v.findInPage(q, { forward: true });
}

function findInPageNext(forward) {
  const v = currentTab && currentTab.view;
  const inp = document.getElementById("findInput");
  if (!v || !inp || !v.findInPage) return;
  const q = inp.value;
  if (!q) return;
  v.findInPage(q, { forward, findNext: true });
}

function switchTab(id) {
  const findBar = document.getElementById("findBar");
  if (findBar && findBar.style.display === "flex") {
    closeFindInPage();
  }

  tabs.forEach(t => {
    t.view.style.display = "none";
    t.tab.classList.remove("active");
  });

  const selected = tabs.find(t => t.id === id);
  if (!selected) return;

  selected.view.style.display = "flex";
  selected.tab.classList.add("active");

  currentTab = selected;
  document.getElementById("url").value = cleanUrl(
    webviewDisplayUrl(selected.view)
  );
}

function closeTab(id) {
  const index = tabs.findIndex(t => t.id === id);
  if (index === -1) return;

  const tab = tabs[index];
  tab.view.remove();
  tab.tab.remove();

  tabs.splice(index, 1);

  if (tabs.length > 0) {
    switchTab(tabs[Math.max(0, index - 1)].id);
  } else {
    ipcRenderer.send("bavarium-close-shell-window");
  }
}

function stripAllTabsSilently() {
  closeFindInPage();
  for (const t of [...tabs]) {
    try {
      t.view.remove();
    } catch (_) {}
    try {
      t.tab.remove();
    } catch (_) {}
  }
  tabs.length = 0;
  currentTab = null;
}

function bootstrapShellWithFirstTab(p) {
  const url =
    typeof p.url === "string" && p.url.trim() ? p.url.trim() : null;
  newTab(url, { incognito: !!p.incognito });
  if (p.muted && currentTab && currentTab.view && currentTab.view.setAudioMuted) {
    try {
      currentTab.view.setAudioMuted(true);
    } catch (_) {}
  }
}

function applyPendingBootstrapTab() {
  if (!pendingBootstrapTab) return;
  const p = pendingBootstrapTab;
  pendingBootstrapTab = null;
  if (tabs.length > 0) stripAllTabsSilently();
  bootstrapShellWithFirstTab(p);
}

ipcRenderer.on("bavarium-bootstrap-tab", (_e, payload) => {
  if (!payload || typeof payload !== "object") return;
  pendingBootstrapTab = payload;
  if (document.readyState === "complete") {
    applyPendingBootstrapTab();
  }
});

function refreshTabsDomOrder() {
  const tabsEl = document.getElementById("tabs");
  if (!tabsEl) return;
  for (const t of tabs) {
    tabsEl.appendChild(t.tab);
  }
  /* Do not reorder <webview> nodes: moving them in the DOM reloads/resets the guest. */
}

function moveTabToEnd(dragId) {
  const fromIdx = tabs.findIndex((t) => t.id === dragId);
  if (fromIdx === -1 || fromIdx === tabs.length - 1) return;
  const [entry] = tabs.splice(fromIdx, 1);
  tabs.push(entry);
  refreshTabsDomOrder();
}

function reorderTabBefore(dragId, beforeId) {
  const fromIdx = tabs.findIndex((t) => t.id === dragId);
  let toIdx = tabs.findIndex((t) => t.id === beforeId);
  if (fromIdx === -1 || toIdx === -1) return;
  if (fromIdx === toIdx) return;
  const [entry] = tabs.splice(fromIdx, 1);
  if (fromIdx < toIdx) {
    toIdx--;
  }
  tabs.splice(toIdx, 0, entry);
  refreshTabsDomOrder();
}

function tabPayloadForNewWindow(te) {
  let loadUrl = "";
  try {
    loadUrl = te.view.getURL() || "";
  } catch (_) {}
  if (!loadUrl) {
    try {
      loadUrl = te.view.src || "";
    } catch (_) {}
  }
  let muted = false;
  try {
    if (te.view.isAudioMuted) muted = te.view.isAudioMuted();
  } catch (_) {}
  return {
    url: loadUrl,
    incognito: !!te.incognito,
    muted,
  };
}

function openTabInNewWindow(id) {
  const te = tabs.find((t) => t.id === id);
  if (!te) return;
  ipcRenderer.send("bavarium-open-tab-in-new-window", tabPayloadForNewWindow(te));
  closeTab(id);
}

function toggleTabMute(id) {
  const te = tabs.find((t) => t.id === id);
  if (!te || !te.view || !te.view.setAudioMuted || !te.view.isAudioMuted) return;
  try {
    te.view.setAudioMuted(!te.view.isAudioMuted());
  } catch (_) {}
}

function initTabStripContainer() {
  const strip = document.getElementById("tabs");
  if (!strip || strip.dataset.bavariumStripInit === "1") return;
  strip.dataset.bavariumStripInit = "1";
  strip.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });
  strip.addEventListener("drop", (e) => {
    if (e.target !== strip) return;
    e.preventDefault();
    const raw = e.dataTransfer.getData("application/x-bavarium-tab-id");
    const dragId = parseInt(raw, 10);
    if (!Number.isFinite(dragId)) return;
    moveTabToEnd(dragId);
  });
}

function attachTabStripInteractions(tabEl, id) {
  let tabDragActive = false;

  tabEl.addEventListener("dragstart", (e) => {
    if (e.target && e.target.closest && e.target.closest(".tab-close")) {
      e.preventDefault();
      return;
    }
    tabDragActive = true;
    tabEl.classList.add("tab-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-bavarium-tab-id", String(id));
  });

  tabEl.addEventListener("dragend", (e) => {
    tabEl.classList.remove("tab-dragging");
    const te = tabs.find((t) => t.id === id);
    if (te && e.dataTransfer.dropEffect !== "move") {
      const margin = 28;
      const sx = window.screenX;
      const sy = window.screenY;
      const sw = window.outerWidth;
      const sh = window.outerHeight;
      const x = e.screenX;
      const y = e.screenY;
      const outside =
        x < sx - margin ||
        x > sx + sw + margin ||
        y < sy - margin ||
        y > sy + sh + margin;
      if (outside) {
        ipcRenderer.send(
          "bavarium-open-tab-in-new-window",
          tabPayloadForNewWindow(te)
        );
        closeTab(id);
      }
    }
    setTimeout(() => {
      tabDragActive = false;
    }, 0);
  });

  tabEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
  });

  tabEl.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const raw = e.dataTransfer.getData("application/x-bavarium-tab-id");
    const dragId = parseInt(raw, 10);
    if (!Number.isFinite(dragId) || dragId === id) return;
    reorderTabBefore(dragId, id);
  });

  tabEl.addEventListener("click", (ev) => {
    if (ev.target.closest && ev.target.closest(".tab-close")) return;
    if (tabDragActive) return;
    switchTab(id);
  });

  tabEl.addEventListener("contextmenu", (e) => {
    if (e.target.closest && e.target.closest(".tab-close")) return;
    e.preventDefault();
    e.stopPropagation();
    const te = tabs.find((t) => t.id === id);
    if (!te) return;
    const { Menu, BrowserWindow } = require("electron");
    let muted = false;
    try {
      muted = te.view.isAudioMuted && te.view.isAudioMuted();
    } catch (_) {}
    const template = [
      {
        label: "Open in New Window",
        click: () => openTabInNewWindow(id),
      },
      { type: "separator" },
      {
        label: muted ? "Unmute Tab" : "Mute Tab",
        click: () => {
          toggleTabMute(id);
        },
      },
    ];
    const win = BrowserWindow.getFocusedWindow();
    Menu.buildFromTemplate(template).popup({
      window: win || undefined,
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
    });
  });
}

function getSettings() {
  const settings = JSON.parse(localStorage.getItem("settings") || "{}");

  if (settings.homepage === "frogies") settings.homepage = "google";
  if (!settings.homepage) settings.homepage = "google";
  if (settings.proxyType === "frogies") settings.proxyType = "ultraviolet";
  if (!settings.proxyType) settings.proxyType = "ultraviolet";
  if (!settings.searchEngine) settings.searchEngine = "google";
  if (settings.historyEnabled === undefined) settings.historyEnabled = true;
  if (settings.askBeforeDownload === undefined) settings.askBeforeDownload = true;
  if (settings.proxyEnabled === undefined) settings.proxyEnabled = true;

  return settings;
}

function shouldRecordHistoryUrl(url) {
  if (!url || url.startsWith("file://")) return false;
  if (url.includes("settings.html")) return false;
  if (url.startsWith("bavarium://")) return false;
  return true;
}

function appendHistoryForNavigation(view, rawUrl) {
  if (viewIsIncognito(view)) return;
  const s = getSettings();
  if (s.historyEnabled === false) return;
  const cleaned = cleanUrl(rawUrl);
  if (!shouldRecordHistoryUrl(cleaned)) return;
  let t = cleaned;
  try {
    if (view.getTitle) t = view.getTitle() || cleaned;
  } catch (_) {}
  ipcRenderer.send("history-append", {
    url: cleaned,
    title: t,
    ts: Date.now(),
  });
}

function searchUrlForQuery(query, searchEngine) {
  const q = encodeURIComponent(query);
  if (searchEngine === "duckduckgo") {
    return `https://duckduckgo.com/?q=${q}`;
  }
  if (searchEngine === "brave") {
    return `https://search.brave.com/search?q=${q}`;
  }
  if (searchEngine === "yandex") {
    return `https://yandex.com/search/?text=${q}`;
  }
  return `https://www.google.com/search?q=${q}`;
}

/**
 * Omnibox: navigate for URLs / hostnames; otherwise treat as a search query.
 */
function resolveOmniboxInput(raw) {
  const input = raw.trim();
  if (!input) return null;

  if (input.startsWith("bavarium://")) {
    return { kind: "internal", url: input };
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) {
    return { kind: "url", url: input };
  }

  if (/\s/.test(input)) {
    return { kind: "search", query: input };
  }

  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(input)) {
    return { kind: "url", url: `http://${input}` };
  }

  if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(input)) {
    return { kind: "url", url: `http://${input}` };
  }

  const hostPart = input.split("/")[0].split("?")[0];
  if (
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(
      hostPart
    ) &&
    hostPart.includes(".")
  ) {
    return { kind: "url", url: `https://${input}` };
  }

  return { kind: "search", query: input };
}

function go() {
  const input = document.getElementById("url").value.trim();
  navigateCurrentTab(input);
}

function navigateCurrentTab(rawInput) {
  const input = String(rawInput || "").trim();
  if (!input) return;

  const settings = getSettings();
  const searchEngine = settings.searchEngine || "google";

  const resolved = resolveOmniboxInput(input);
  if (!resolved) return;

  if (resolved.kind === "internal") {
    handleInternal(resolved.url);
    return;
  }

  let url =
    resolved.kind === "url"
      ? resolved.url
      : searchUrlForQuery(resolved.query, searchEngine);

  url = wrapUrlForProxyIfNeeded(url, settings);

  if (isOpposingProxyHomepageUrl(url, settings)) {
    notifyOpposingProxyHomepageBlocked(settings);
    return;
  }

  if (currentTab && currentTab.view) {
    currentTab.view.src = url;
  }
}

const BOOKMARKS_KEY = "bavarium-bookmarks";

const DEFAULT_BOOKMARK_FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#9aa0a6"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
  );

function bavariumInternalFaviconDataUri(url) {
  try {
    const parsed = new URL(url);
    const host = (parsed.hostname || "").toLowerCase();
    const colors = {
      settings: "#4285f4",
      proxy: "#34a853",
      browsing: "#f9ab00",
      history: "#ea4335",
      privacy: "#ab47bc",
      downloads: "#00897b",
      newtab: "#607d8b",
      licenses: "#5c6bc0",
    };
    let fill = colors[host] || "#5f6368";
    if (host === "licenses") {
      const p = (parsed.pathname || "").toLowerCase();
      if (p.includes("scramjet")) fill = "#7e57c2";
      else if (p.includes("ultraviolet")) fill = "#42a5f5";
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${fill}" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;
    return "data:image/svg+xml," + encodeURIComponent(svg);
  } catch {
    return DEFAULT_BOOKMARK_FAVICON;
  }
}

function faviconUrlForBookmarkUrl(url) {
  if (!url || typeof url !== "string") return DEFAULT_BOOKMARK_FAVICON;
  const trimmed = url.trim();
  if (trimmed.startsWith("bavarium://")) {
    return bavariumInternalFaviconDataUri(trimmed);
  }
  try {
    let target = trimmed;
    try {
      const parsed = new URL(
        trimmed.startsWith("http://") || trimmed.startsWith("https://")
          ? trimmed
          : "https://" + trimmed.replace(/^\/+/, "")
      );
      const q = parsed.searchParams.get("url");
      const isLocalProxy = /localhost|127\.0\.0\.1/.test(parsed.hostname);
      if (q && isLocalProxy) {
        try {
          target = decodeURIComponent(q);
        } catch (_) {}
      }
    } catch (_) {}
    const p = new URL(
      target.startsWith("http://") || target.startsWith("https://")
        ? target
        : "https://" + target.replace(/^\/+/, "")
    );
    if (p.protocol !== "http:" && p.protocol !== "https:") {
      return DEFAULT_BOOKMARK_FAVICON;
    }
    const host = p.hostname;
    if (!host || host === "localhost" || host === "127.0.0.1") {
      return DEFAULT_BOOKMARK_FAVICON;
    }
    return `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(
      host
    )}`;
  } catch {
    return DEFAULT_BOOKMARK_FAVICON;
  }
}

function loadBookmarks() {
  try {
    const raw = localStorage.getItem(BOOKMARKS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveBookmarksList(list) {
  localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(list));
  renderBookmarkBar();
}

let editingBookmarkId = null;

function newBookmarkId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function renderBookmarkBar() {
  const bar = document.getElementById("bookmarkbarItems");
  if (!bar) return;
  bar.innerHTML = "";
  loadBookmarks().forEach((bm) => {
    const wrap = document.createElement("span");
    wrap.className = "bookmark-item";
    const bmName = (bm.title && bm.title.trim()) || "Bookmark";
    wrap.title = `Open: ${bmName}\n${bm.url}`;

    const icon = document.createElement("img");
    icon.className = "bm-favicon";
    icon.width = 16;
    icon.height = 16;
    icon.alt = "";
    icon.referrerPolicy = "no-referrer";
    icon.decoding = "async";
    icon.src = bm.faviconUrl || faviconUrlForBookmarkUrl(bm.url);
    icon.addEventListener("error", () => {
      icon.src = DEFAULT_BOOKMARK_FAVICON;
      icon.onerror = null;
    });

    const label = document.createElement("span");
    label.className = "bm-label";
    label.textContent = bm.title || bm.url;

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "bm-edit";
    editBtn.textContent = "✎";
    editBtn.title = "Edit this bookmark";
    editBtn.setAttribute("aria-label", "Edit bookmark");
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openBookmarkEditor(bm.id);
    });

    wrap.appendChild(icon);
    wrap.appendChild(label);
    wrap.appendChild(editBtn);
    wrap.addEventListener("click", (e) => {
      if (e.target.closest(".bm-edit")) return;
      navigateCurrentTab(bm.url);
    });

    bar.appendChild(wrap);
  });
}

function openBookmarkEditor(id) {
  const modal = document.getElementById("bookmarkModal");
  const titleIn = document.getElementById("bookmarkEditTitle");
  const urlIn = document.getElementById("bookmarkEditUrl");
  const removeBtn = document.getElementById("bookmarkBtnRemove");
  const modalHeading = document.getElementById("bookmarkModalTitle");
  if (!modal || !titleIn || !urlIn) return;

  editingBookmarkId = id || null;

  if (id) {
    const bm = loadBookmarks().find((b) => b.id === id);
    if (!bm) return;
    titleIn.value = bm.title || "";
    urlIn.value = bm.url || "";
    if (modalHeading) modalHeading.textContent = "Edit bookmark";
    if (removeBtn) removeBtn.style.display = "";
  } else {
    titleIn.value = "";
    try {
      if (currentTab && currentTab.view && currentTab.view.getTitle) {
        titleIn.value = currentTab.view.getTitle() || "";
      }
    } catch (_) {}
    urlIn.value = document.getElementById("url")
      ? document.getElementById("url").value || ""
      : "";
    if (modalHeading) modalHeading.textContent = "Add bookmark";
    if (removeBtn) removeBtn.style.display = "none";
  }

  modal.style.display = "flex";
  setTimeout(() => titleIn.focus(), 50);
}

function closeBookmarkEditor() {
  const modal = document.getElementById("bookmarkModal");
  if (modal) modal.style.display = "none";
  editingBookmarkId = null;
}

function saveBookmarkFromModal() {
  const titleIn = document.getElementById("bookmarkEditTitle");
  const urlIn = document.getElementById("bookmarkEditUrl");
  if (!titleIn || !urlIn) return;
  const title = titleIn.value.trim() || "Bookmark";
  const url = urlIn.value.trim();
  if (!url) {
    alert("URL is required.");
    return;
  }
  let list = loadBookmarks();
  const faviconUrl = faviconUrlForBookmarkUrl(url);
  if (editingBookmarkId) {
    const i = list.findIndex((b) => b.id === editingBookmarkId);
    if (i !== -1) {
      list[i] = { ...list[i], title, url, faviconUrl };
    }
  } else {
    list.push({ id: newBookmarkId(), title, url, faviconUrl });
  }
  saveBookmarksList(list);
  closeBookmarkEditor();
}

function removeBookmarkFromModal() {
  if (!editingBookmarkId) return;
  const list = loadBookmarks().filter((b) => b.id !== editingBookmarkId);
  saveBookmarksList(list);
  closeBookmarkEditor();
}


function goBack() {
  if (currentTab && currentTab.view.canGoBack()) {
    currentTab.view.goBack();
  }
}

function goForward() {
  if (currentTab && currentTab.view.canGoForward()) {
    currentTab.view.goForward();
  }
}

function refresh() {
  if (currentTab) currentTab.view.reload();
}

function bavariumUrlToHash(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "bavarium:") return "settings";
    const host = (u.hostname || "").toLowerCase();
    const frag = (u.hash || "").replace(/^#/, "").toLowerCase();
    const pathSegs = (u.pathname || "").replace(/^\//, "").split("/").filter(Boolean);
    const seg = pathSegs[0] || "";
    if (host === "licenses") {
      const key = (pathSegs[0] || "").toLowerCase() || frag;
      if (key === "scramjet") return "licenses-scramjet";
      if (key === "ultraviolet") return "licenses-ultraviolet";
      if (!key) return "licenses";
    }
    const valid = new Set([
      "settings",
      "proxy",
      "browsing",
      "history",
      "privacy",
      "downloads",
    ]);
    if (frag && valid.has(frag)) return frag;
    if (seg && valid.has(seg)) return seg;
    const hostMap = {
      settings: "settings",
      proxy: "proxy",
      browsing: "browsing",
      history: "history",
      privacy: "privacy",
      downloads: "downloads",
    };
    if (hostMap[host]) return hostMap[host];
    return "settings";
  } catch {
    return "settings";
  }
}

function handleInternal(url, targetView) {
  if (isBavariumNewTabUrl(url)) {
    newTab();
    return;
  }
  const view = targetView || (currentTab && currentTab.view);
  if (!view) return;
  const base = new URL("settings.html", window.location.href).href.split("#")[0];
  const hash = bavariumUrlToHash(url);
  view.src = `${base}#${hash}`;
}

function settingsFileToBavariumDisplay(fileUrl) {
  try {
    const u = new URL(fileUrl);
    if (!u.pathname.endsWith("settings.html")) return null;
    const h = (u.hash || "").replace(/^#/, "") || "settings";
    const map = {
      settings: "bavarium://settings",
      proxy: "bavarium://proxy",
      browsing: "bavarium://browsing",
      history: "bavarium://history",
      privacy: "bavarium://privacy",
      downloads: "bavarium://downloads",
      licenses: "bavarium://licenses",
      "licenses-scramjet": "bavarium://licenses/scramjet",
      "licenses-ultraviolet": "bavarium://licenses/ultraviolet",
    };
    return map[h] || "bavarium://settings";
  } catch {
    return null;
  }
}

function webviewDisplayUrl(view) {
  try {
    if (view && view.getURL) return view.getURL() || view.src || "";
  } catch (_) {}
  return view ? view.src || "" : "";
}

function cleanUrl(url) {
  const pretty = settingsFileToBavariumDisplay(url);
  if (pretty) return pretty;
  const s = getSettings();
  try {
    const u = new URL(url);
    if (
      (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
      u.searchParams.has("url")
    ) {
      return decodeURIComponent(u.searchParams.get("url"));
    }
  } catch {}
  return url;
}

function toggleMenu() {
  const menu = document.getElementById("menu");
  if (!menu) return;
  menu.style.display = menu.style.display === "block" ? "none" : "block";
}

// close menu when clicking outside
document.addEventListener("click", (e) => {
  const menu = document.getElementById("menu");
  if (!menu) return;

  if (!e.target.closest("#menu") && !e.target.closest("button")) {
    menu.style.display = "none";
  }
});

function applySettingsPayload(settings) {
  if (!settings || typeof settings !== "object") return;
  const proxyType =
    settings.proxyType === "frogies"
      ? "ultraviolet"
      : settings.proxyType || "ultraviolet";
  const homepage =
    settings.homepage === "frogies"
      ? "google"
      : settings.homepage || "google";
  const merged = {
    searchEngine: settings.searchEngine || "google",
    proxyType,
    transport: settings.transport || "epoxy",
    wssServer: settings.wssServer || "",
    proxyEnabled: settings.proxyEnabled !== false,
    uvPort: settings.uvPort || "8080",
    scramjetPort: settings.scramjetPort || "3000",
    homepage,
    historyEnabled: settings.historyEnabled !== false,
    askBeforeDownload: settings.askBeforeDownload !== false,
    downloadPath: settings.downloadPath || "",
  };
  localStorage.setItem("settings", JSON.stringify(merged));
}

window.onload = async () => {
  try {
    const fileSettings = await ipcRenderer.invoke("get-settings");
    applySettingsPayload(fileSettings);
  } catch (e) {
    console.warn("get-settings failed:", e);
  }

  initTabStripContainer();

  if (pendingBootstrapTab) {
    const p = pendingBootstrapTab;
    pendingBootstrapTab = null;
    if (tabs.length > 0) stripAllTabsSilently();
    bootstrapShellWithFirstTab(p);
  } else if (tabs.length === 0) {
    newTab();
  }

  renderBookmarkBar();

  const btnAddBm = document.getElementById("btnAddBookmark");
  if (btnAddBm) {
    btnAddBm.addEventListener("click", () => openBookmarkEditor(null));
  }
  const bmSave = document.getElementById("bookmarkBtnSave");
  const bmCancel = document.getElementById("bookmarkBtnCancel");
  const bmRemove = document.getElementById("bookmarkBtnRemove");
  const bmModal = document.getElementById("bookmarkModal");
  if (bmSave) bmSave.addEventListener("click", saveBookmarkFromModal);
  if (bmCancel) bmCancel.addEventListener("click", closeBookmarkEditor);
  if (bmRemove) bmRemove.addEventListener("click", removeBookmarkFromModal);
  if (bmModal) {
    bmModal.addEventListener("click", (e) => {
      if (e.target === bmModal) closeBookmarkEditor();
    });
  }
  ["bookmarkEditTitle", "bookmarkEditUrl"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          saveBookmarkFromModal();
        }
      });
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const findBar = document.getElementById("findBar");
    if (findBar && findBar.style.display === "flex") {
      e.preventDefault();
      closeFindInPage();
      return;
    }
    const m = document.getElementById("bookmarkModal");
    if (m && m.style.display === "flex") {
      e.preventDefault();
      closeBookmarkEditor();
    }
  });

  const urlInput = document.getElementById("url");
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      go();
    }
  });

  ipcRenderer.on("bavarium-menu-action", (_e, action) => {
    if (typeof action !== "string") return;
    if (action.startsWith("tab-")) {
      const n = parseInt(action.slice(4), 10);
      if (!Number.isFinite(n)) return;
      if (n === 9) {
        if (tabs.length > 0) switchTab(tabs[tabs.length - 1].id);
      } else if (n >= 1 && n <= tabs.length) {
        switchTab(tabs[n - 1].id);
      }
      return;
    }
    switch (action) {
      case "new-tab":
        newTab();
        break;
      case "incognito-tab":
        newTab(null, { incognito: true });
        break;
      case "close-tab":
        if (currentTab) closeTab(currentTab.id);
        break;
      case "reload":
        refresh();
        break;
      case "find-in-page":
        openFindInPage();
        break;
      case "bookmark-page":
        openBookmarkEditor(null);
        break;
      case "focus-url": {
        const el = document.getElementById("url");
        if (el) {
          el.focus();
          el.select();
        }
        break;
      }
      case "settings":
        newTab("bavarium://settings");
        break;
      case "proxy":
        newTab("bavarium://proxy");
        break;
      case "browsing":
        newTab("bavarium://browsing");
        break;
      case "history":
        newTab("bavarium://history");
        break;
      case "downloads":
        newTab("bavarium://downloads");
        break;
      default:
        break;
    }
  });

  ipcRenderer.on("bavarium-new-tab-with-url", (_e, payload) => {
    let url = "";
    let background = false;
    let incognito = false;
    if (typeof payload === "string" && payload) {
      url = payload;
    } else if (payload && typeof payload === "object" && typeof payload.url === "string") {
      url = payload.url;
      background = !!payload.background;
      incognito = !!payload.incognito;
    }
    if (!url) return;
    newTab(url, { background, incognito });
  });

  document.addEventListener("keydown", (e) => {
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const ctrl = isMac ? e.metaKey : e.ctrlKey;

  if (!ctrl) return;

  const key = e.key.toLowerCase();

  if (ctrl && e.shiftKey && key === "n") {
    e.preventDefault();
    newTab(null, { incognito: true });
    return;
  }

  if (ctrl && e.altKey && key === "l") {
    e.preventDefault();
    newTab("bavarium://downloads");
    return;
  }

  if (key === "f") {
    e.preventDefault();
    openFindInPage();
    return;
  }

  if (key === "d") {
    e.preventDefault();
    openBookmarkEditor(null);
    return;
  }

  if (key === "n" && !e.shiftKey) {
    e.preventDefault();
    ipcRenderer.send("bavarium-new-window");
    return;
  }

  // 🔥 tab switching (ctrl/cmd + 1-9)
  if (!isNaN(key)) {
    e.preventDefault();

    const num = parseInt(key);

    if (num === 9) {
      // last tab
      if (tabs.length > 0) switchTab(tabs[tabs.length - 1].id);
    } else if (num > 0 && num <= tabs.length) {
      switchTab(tabs[num - 1].id);
    }

    return;
  }

  switch (key) {
    case "w":
      e.preventDefault();
      if (currentTab) closeTab(currentTab.id);
      break;

    case "r":
      e.preventDefault();
      refresh();
      break;

    case "t":
      e.preventDefault();
      newTab();
      break;

    case ",":
      e.preventDefault();
      newTab("bavarium://settings");
      break;
  }
  });

  const findInput = document.getElementById("findInput");
  if (findInput) {
    let findT;
    findInput.addEventListener("input", () => {
      clearTimeout(findT);
      findT = setTimeout(() => findInPageSchedule(), 60);
    });
    findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        findInPageNext(!e.shiftKey);
      }
    });
  }
  const findPrev = document.getElementById("findPrev");
  const findNext = document.getElementById("findNext");
  const findClose = document.getElementById("findClose");
  if (findPrev) findPrev.addEventListener("click", () => findInPageNext(false));
  if (findNext) findNext.addEventListener("click", () => findInPageNext(true));
  if (findClose) findClose.addEventListener("click", () => closeFindInPage());

  ipcRenderer.on("settings-updated", (_e, settings) => {
    applySettingsPayload(settings);
    document.querySelectorAll("webview").forEach((wv) => {
      const src = wv.getAttribute("src") || "";
      if (src.includes("settings.html")) {
        wv.executeJavaScript(
          "window.__bavariumRefreshHistory && window.__bavariumRefreshHistory()"
        ).catch(() => {});
      }
    });
  });

  ipcRenderer.on("downloads-updated", () => {
    document.querySelectorAll("webview").forEach((wv) => {
      const src = wv.getAttribute("src") || "";
      if (src.includes("settings.html")) {
        wv.executeJavaScript(
          "window.__bavariumRefreshDownloads && window.__bavariumRefreshDownloads()"
        ).catch(() => {});
      }
    });
  });

  ipcRenderer.on("browser-data-cleared", async () => {
    try {
      localStorage.removeItem(BOOKMARKS_KEY);
    } catch (_) {}
    try {
      const fileSettings = await ipcRenderer.invoke("get-settings");
      applySettingsPayload(fileSettings);
    } catch (_) {}
    renderBookmarkBar();
    tabs.forEach((t) => {
      if (t.view) {
        try {
          t.view.reload();
        } catch (_) {}
      }
    });
  });

  ipcRenderer.on("proxy-switched", () => {
    console.log("Proxy switched → reloading tabs");
    tabs.forEach((t) => {
      if (t.view) t.view.reload();
    });
  });

  const menuEl = document.getElementById("menu");
  if (menuEl) {
    menuEl.addEventListener("click", (e) => {
      const item = e.target.closest("[data-bavarium]");
      if (!item) return;
      e.stopPropagation();
      newTab(item.dataset.bavarium);
      menuEl.style.display = "none";
    });
  }
};
