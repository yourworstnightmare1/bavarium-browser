let tabs = [];
let currentTab = null;
let tabId = 0;

const { ipcRenderer, webContents, shell } = require("electron");

const GITHUB_REPO_URL = "https://github.com/yourworstnightmare1/bavarium-browser";
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

let pendingBootstrapTab = null;
let devtoolsHostWebContentsId = null;
let devtoolsOpenForTabId = null;
/** True while the user is editing the address bar (do not overwrite from webview sync). */
let urlOmniboxUserEditing = false;
/** Debounced UV shell hash updates per webview. */
const uvShellNavByView = new WeakMap();

function setAltMenuBarHeld(held) {
  if (process.platform === "darwin") {
    return;
  }
  ipcRenderer.send("bavarium-alt-menu-visibility", !!held);
}

function onAltMenuKeyDown(e) {
  if (e.key === "Alt") {
    setAltMenuBarHeld(true);
  }
}

function onAltMenuKeyUp(e) {
  if (e.key === "Alt" || !e.altKey) {
    setAltMenuBarHeld(false);
  }
}

const BAVARIUM_LINK_CLICK_PATCH = `(function() {
  if (window.__bavariumLinkClickPatch) return;
  window.__bavariumLinkClickPatch = true;
  document.addEventListener("click", function(e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href^="bavarium:"]') : null;
    if (!a) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    try {
      var ipc = require("electron").ipcRenderer;
      ipc.sendToHost("bavarium-internal-nav", a.getAttribute("href"));
    } catch (err) {}
  }, true);
})();`;

const BAVARIUM_SHELL_HTTP_LINK_PATCH = `(function() {
  if (window.__bavariumShellHttpLinkPatch) return;
  window.__bavariumShellHttpLinkPatch = true;
  function isShellPage() {
    try {
      if (location.protocol !== "file:") return false;
      var p = location.pathname.replace(/\\\\/g, "/").toLowerCase();
      return p.endsWith("/newtab.html") || p.endsWith("/settings.html");
    } catch (e) {
      return false;
    }
  }
  document.addEventListener("click", function(e) {
    if (!isShellPage()) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (!href || href.charAt(0) === "#" || href.indexOf("bavarium:") === 0 || href.indexOf("javascript:") === 0) return;
    var abs;
    try {
      abs = new URL(href, location.href).href;
      var u = new URL(abs);
      if (u.protocol !== "http:" && u.protocol !== "https:") return;
    } catch (err) {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    try {
      require("electron").ipcRenderer.sendToHost("bavarium-open-external-url", abs);
    } catch (err2) {}
  }, true);
})();`;

/** Notify shell when proxied inner frame URL/title changes (same-origin to proxy shell). */
const BAVARIUM_PAGE_META_WATCHER = `(function() {
  if (window.__bavariumPageMetaWatch) return;
  window.__bavariumPageMetaWatch = true;
  function ping() {
    try {
      require("electron").ipcRenderer.sendToHost("bavarium-page-meta-changed");
    } catch (e) {}
  }
  function hookHistory(w) {
    if (!w || !w.history || w.__bavariumHistoryHook) return;
    try {
      w.__bavariumHistoryHook = true;
      var push = w.history.pushState;
      var replace = w.history.replaceState;
      if (push) {
        w.history.pushState = function() {
          var r = push.apply(this, arguments);
          ping();
          return r;
        };
      }
      if (replace) {
        w.history.replaceState = function() {
          var r = replace.apply(this, arguments);
          ping();
          return r;
        };
      }
      w.addEventListener("popstate", ping);
      w.addEventListener("hashchange", ping);
    } catch (e) {}
  }
  function hookFrame(f) {
    if (!f || f.__bavariumMetaHook) return;
    f.__bavariumMetaHook = true;
    try {
      f.addEventListener("load", ping);
    } catch (e) {}
    try {
      var srcObs = new MutationObserver(ping);
      srcObs.observe(f, { attributes: true, attributeFilter: ["src"] });
    } catch (e) {}
    try {
      var w = f.contentWindow;
      if (w) hookHistory(w);
    } catch (e) {}
    try {
      var doc = f.contentDocument;
      if (doc) {
        var titleEl = doc.querySelector("title");
        if (titleEl) {
          var obs = new MutationObserver(ping);
          obs.observe(titleEl, { childList: true, characterData: true, subtree: true });
        }
        hookHistory(doc.defaultView);
        var innerFrames = doc.querySelectorAll("iframe");
        for (var i = 0; i < innerFrames.length; i++) hookFrame(innerFrames[i]);
      }
    } catch (e) {}
  }
  function scan() {
    hookFrame(document.getElementById("sj-frame"));
    hookFrame(document.getElementById("uv-frame"));
  }
  scan();
  try {
    var rootObs = new MutationObserver(scan);
    rootObs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
  setInterval(ping, 500);
})();`;

const guestPageMetaTimers = new Map();
const guestPageMetaThrottle = new WeakMap();

/** Guest JS in a <webview> (webContents.fromId is not available in this renderer). */
function webviewGuestExecuteJavaScript(view, code, userGesture = true) {
  if (!view) return Promise.reject(new Error("no webview"));
  if (typeof view.executeJavaScript === "function") {
    return view.executeJavaScript(code, userGesture);
  }
  const id = view.getWebContentsId?.();
  if (id == null) return Promise.reject(new Error("no guest id"));
  const wc = webContents?.fromId?.(id);
  if (!wc || wc.isDestroyed()) {
    return Promise.reject(new Error("guest webContents unavailable"));
  }
  return wc.executeJavaScript(code, userGesture);
}

function injectBavariumLinkClickCapture(view) {
  if (!view) return;
  webviewGuestExecuteJavaScript(view, BAVARIUM_LINK_CLICK_PATCH, true).catch(
    () => {}
  );
  webviewGuestExecuteJavaScript(view, BAVARIUM_SHELL_HTTP_LINK_PATCH, true).catch(
    () => {}
  );
}

function injectPageMetaWatcher(view) {
  if (!view) return;
  webviewGuestExecuteJavaScript(view, BAVARIUM_PAGE_META_WATCHER, true).catch(
    () => {}
  );
}

function isBavariumShellFilePageUrl(pageUrl) {
  if (!pageUrl || typeof pageUrl !== "string") return false;
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== "file:") return false;
    const p = u.pathname.replace(/\\/g, "/").toLowerCase();
    return p.endsWith("/newtab.html") || p.endsWith("/settings.html");
  } catch {
    return false;
  }
}

function isHttpOrHttpsUrl(url) {
  return /^https?:/i.test(String(url || ""));
}

let externalLinkModalState = null;

function getExternalLinkOpenPreference() {
  const pref = getSettings().externalLinkOpenPreference;
  if (pref === "external" || pref === "bavarium") return pref;
  return "ask";
}

async function saveExternalLinkOpenPreference(pref) {
  const disk = await ipcRenderer.invoke("get-settings");
  const next = { ...disk, externalLinkOpenPreference: pref };
  ipcRenderer.send("save-settings", next);
  applySettingsPayload(next);
}

function openExternalLinkInBavarium(url, sourceView, options = {}) {
  const background = !!options.background;
  const incognito = !!options.incognito;
  if (background) {
    void (async () => {
      const settings = getSettings();
      if (settings.safeBrowsingEnabled !== false) {
        try {
          const check = await ipcRenderer.invoke("safe-browsing-check-url", url);
          if (check && check.blocked) {
            const te = newTab(null, { background: true, incognito });
            showUnsafeSiteWarning(te, url, check);
            return;
          }
        } catch (_) {}
      }
      const te = newTab(null, { background: true, incognito });
      performNavigateToDestination(te, url, settings);
    })();
    return;
  }
  const te = sourceView ? tabEntryForView(sourceView) : currentTab;
  if (te && te.view) {
    const prev = currentTab;
    currentTab = te;
    void navigateCurrentTab(url);
    if (prev && prev.id !== te.id) switchTab(te.id);
    return;
  }
  void (async () => {
    const settings = getSettings();
    if (settings.safeBrowsingEnabled !== false) {
      try {
        const check = await ipcRenderer.invoke("safe-browsing-check-url", url);
        if (check && check.blocked) {
          const tab = newTab(null, { incognito });
          showUnsafeSiteWarning(tab, url, check);
          return;
        }
      } catch (_) {}
    }
    const tab = newTab(null, { incognito });
    performNavigateToDestination(tab, url, settings);
  })();
}

function openExternalLinkExternally(url) {
  shell.openExternal(url).catch(() => {});
}

function closeExternalLinkModal() {
  const modal = document.getElementById("externalLinkModal");
  if (modal) modal.style.display = "none";
  setShellModalOpen(false);
  externalLinkModalState = null;
}

function showExternalLinkModal(url, sourceView, options = {}) {
  const modal = document.getElementById("externalLinkModal");
  const urlEl = document.getElementById("externalLinkUrl");
  const rememberEl = document.getElementById("externalLinkRemember");
  if (!modal || !urlEl) return;
  urlEl.textContent = url;
  if (rememberEl) rememberEl.checked = false;
  externalLinkModalState = { url, sourceView, options };
  setShellModalOpen(true);
  modal.style.display = "flex";
  const dialog = modal.querySelector(".dialog");
  if (dialog && !dialog.__bavariumDialogStop) {
    dialog.__bavariumDialogStop = true;
    dialog.addEventListener("mousedown", (e) => e.stopPropagation());
  }
}

function completeExternalLinkModal(choice) {
  const state = externalLinkModalState;
  if (!state) return;
  const rememberEl = document.getElementById("externalLinkRemember");
  const remember = !!(rememberEl && rememberEl.checked);
  closeExternalLinkModal();
  if (choice === "external") {
    if (remember) void saveExternalLinkOpenPreference("external");
    openExternalLinkExternally(state.url);
    return;
  }
  if (choice === "bavarium") {
    if (remember) void saveExternalLinkOpenPreference("bavarium");
    openExternalLinkInBavarium(state.url, state.sourceView, state.options);
  }
}

function handleShellExternalLink(url, sourceView, options = {}) {
  const text = String(url || "").trim();
  if (!text || !isHttpOrHttpsUrl(text)) return;
  const pref = getExternalLinkOpenPreference();
  if (pref === "external") {
    openExternalLinkExternally(text);
    return;
  }
  if (pref === "bavarium") {
    openExternalLinkInBavarium(text, sourceView, options);
    return;
  }
  showExternalLinkModal(text, sourceView, options);
}

function attachWebviewBavariumNavigation(view) {
  view.addEventListener("will-navigate", (e) => {
    const url = e.url || "";
    if (url.startsWith("bavarium://")) {
      e.preventDefault();
      handleInternal(url, view);
      return;
    }
    if (isUnsafeWarningPageUrl(url)) return;
    if (
      isHttpOrHttpsUrl(url) &&
      isBavariumShellFilePageUrl(webviewDisplayUrl(view))
    ) {
      e.preventDefault();
      handleShellExternalLink(url, view);
    }
  });

  view.addEventListener("new-window", (e) => {
    const url = e.url || "";
    if (url.startsWith("bavarium://")) {
      e.preventDefault();
      handleInternal(url, view);
    }
  });

  view.addEventListener("ipc-message", (e) => {
    if (e.channel === "bavarium-internal-nav" && e.args && e.args[0]) {
      handleInternal(String(e.args[0]), view);
      return;
    }
    if (e.channel === "bavarium-newtab-navigate" && e.args && e.args[0]) {
      const te = tabEntryForView(view);
      if (te) {
        const prev = currentTab;
        currentTab = te;
        void navigateCurrentTab(String(e.args[0]));
        if (prev && prev.id !== te.id) switchTab(te.id);
      }
      return;
    }
    if (e.channel === "bavarium-unsafe-warning-back") {
      const te = tabEntryForView(view);
      if (!te || !te.view) return;
      const home = new URL("newtab.html", window.location.href).href;
      try {
        if (te.view.canGoBack && te.view.canGoBack()) {
          te.view.goBack();
        } else {
          forceWebviewNavigation(te.view, home);
        }
      } catch (_) {
        forceWebviewNavigation(te.view, home);
      }
      return;
    }
    if (e.channel === "bavarium-unsafe-warning-proceed" && e.args && e.args[0]) {
      const te = tabEntryForView(view);
      const url = String(e.args[0]);
      void ipcRenderer.invoke("safe-browsing-allow-host", url);
      if (te) {
        const prev = currentTab;
        currentTab = te;
        void navigateCurrentTab(url, { bypassSafeBrowsing: true });
        if (prev && prev.id !== te.id) switchTab(te.id);
      } else {
        void navigateCurrentTab(url, { bypassSafeBrowsing: true });
      }
      return;
    }
    if (e.channel === "bavarium-open-external-url" && e.args && e.args[0]) {
      handleShellExternalLink(String(e.args[0]), view);
      return;
    }
    if (e.channel === "bavarium-page-meta-changed") {
      onGuestPageMetaChanged(view);
    }
  });
}

function onGuestPageMetaChanged(view) {
  if (guestPageMetaThrottle.get(view)) return;
  guestPageMetaThrottle.set(view, true);
  setTimeout(() => guestPageMetaThrottle.delete(view), 120);
  void refreshGuestTabPageMeta(view);
}

function stopGuestPageMetaWatcher(tabId) {
  const timer = guestPageMetaTimers.get(tabId);
  if (timer) {
    clearInterval(timer);
    guestPageMetaTimers.delete(tabId);
  }
}

function startGuestPageMetaWatcher(te) {
  if (!te || !te.view || te.incognito) return;
  stopGuestPageMetaWatcher(te.id);
  if (!viewLooksLikeProxyShell(te.view)) return;
  const timer = setInterval(() => {
    void refreshGuestTabPageMeta(te.view);
  }, 1200);
  guestPageMetaTimers.set(te.id, timer);
}

/** Canonical https URL for a remote site (rejects partial hostnames while typing). */
function normalizeRemoteUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t || /^javascript:/i.test(t) || /^data:/i.test(t)) return null;
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase();
    if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return null;
    }
    if (!host.includes(".")) return null;
    return u.href;
  } catch (_) {}
  try {
    const u = new URL(`https://${t}`);
    const host = u.hostname.toLowerCase();
    if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return null;
    }
    if (!host.includes(".")) return null;
    return u.href;
  } catch (_) {
    return null;
  }
}

/** Target site encoded in a local proxy shell URL (`?url=` or `#url=`). */
function proxyShellTargetFromUrl(shellUrl) {
  try {
    const u = new URL(shellUrl);
    if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
      return null;
    }
    let inner = u.searchParams.get("url");
    if (!inner && u.hash) {
      const h = u.hash.replace(/^#/, "");
      if (h.startsWith("url=")) {
        inner = decodeURIComponent(h.slice(4));
      }
    }
    return inner;
  } catch (_) {
    return null;
  }
}

/** Real page URL/title from a proxy shell location (`localhost/?url=…` or `#url=…`). */
function guestPageMetaFromShellUrl(shellUrl) {
  try {
    const inner = proxyShellTargetFromUrl(shellUrl);
    if (!inner) {
      return null;
    }
    const innerHref = normalizeRemoteUrl(inner);
    if (!innerHref) return null;
    let origin = "";
    let title = "";
    try {
      const innerU = new URL(innerHref);
      origin = innerU.origin;
      title = innerU.hostname;
    } catch (_) {}
    return { url: innerHref, title, origin, favicon: "" };
  } catch (_) {
    return null;
  }
}

function primeTabGuestPageFromDestination(te, destinationUrl) {
  if (!te) return;
  const canonical = normalizeRemoteUrl(destinationUrl);
  if (!canonical) return;
  let title = "";
  let origin = "";
  try {
    const u = new URL(canonical);
    title = u.hostname;
    origin = u.origin;
  } catch (_) {}
  te.guestPage = { url: canonical, title, origin, favicon: "" };
  te.fullTitle = title;
  const titleEl = tabTitleElement(te);
  if (titleEl && te.view) {
    applyTabStripLabel(te.view, titleEl, te.incognito, canonical, title, false);
  }
  if (te.faviconImg && te.view) {
    setTabFaviconImg(te.faviconImg, te.view, canonical, null);
  }
  refreshTabTooltip(te);
  updateUrlBarForTab(te);
}

function tabDisplayUrlForOmnibox(te) {
  if (!te) return "";
  try {
    const raw = cleanUrl(webviewDisplayUrl(te.view));
    if (raw.startsWith("bavarium://") || raw.startsWith("file://")) {
      return raw;
    }
  } catch (_) {}
  const canonical = normalizeRemoteUrl(te.guestPage?.url || "");
  if (canonical) return canonical;
  if (te.view && viewLooksLikeProxyShell(te.view)) return "";
  try {
    const cleaned = cleanUrl(webviewDisplayUrl(te.view));
    if (
      cleaned.includes("localhost") ||
      cleaned.startsWith("http://127.0.0.1")
    ) {
      return "";
    }
    return cleaned;
  } catch (_) {
    return "";
  }
}

const SITE_INFO_ICONS = {
  shield: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2 4 5v6c0 5.25 3.5 10.15 8 11.35 4.5-1.2 8-6.1 8-11.35V5L12 2z" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/></svg>`,
  verified: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.75"/><path d="M8 12.5l2.5 2.5L16 9.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  proxy: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.75"/><path d="M2 12h20" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M12 3c4 2.5 4 15.5 0 18" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M12 3c-4 2.5-4 15.5 0 18" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>`,
  file: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M3 9h18" stroke="currentColor" stroke-width="1.75"/></svg>`,
  bavarium: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><ellipse cx="12" cy="5" rx="8" ry="3" stroke="currentColor" stroke-width="1.75"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" stroke="currentColor" stroke-width="1.75"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" stroke="currentColor" stroke-width="1.75"/></svg>`,
};

const SITE_INFO_KINDS = {
  file: {
    label: "Local file",
    icon: SITE_INFO_ICONS.file,
  },
  bavarium: {
    label: "Bavarium page",
    icon: SITE_INFO_ICONS.bavarium,
  },
  reblock: {
    label: "Official ReBlock website",
    icon: SITE_INFO_ICONS.verified,
  },
  https: {
    label: "Secure connection",
    icon: SITE_INFO_ICONS.shield,
  },
  insecure: {
    label: "Connection is not secure",
    icon: SITE_INFO_ICONS.shield,
  },
};

function isOfficialReblockSiteUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (host === "sites.google.com" && path.startsWith("/view/reblock")) {
      return true;
    }
    if (host === "yourworstnightmare1.github.io") {
      return true;
    }
  } catch (_) {}
  return false;
}

function classifySiteInfoKind(url) {
  if (!url || typeof url !== "string") return null;
  const raw = url.trim();
  if (raw.startsWith("file://")) return "file";
  if (raw.startsWith("bavarium://")) return "bavarium";
  let href = raw;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    href = `https://${href}`;
  }
  try {
    const u = new URL(href);
    if (isOfficialReblockSiteUrl(u.href)) return "reblock";
    if (u.protocol === "https:") return "https";
    if (u.protocol === "http:") return "insecure";
  } catch (_) {}
  return null;
}

function resolveSiteInfoHref(url) {
  if (!url || typeof url !== "string") return null;
  const raw = url.trim();
  if (!raw) return null;
  if (raw.startsWith("file://") || raw.startsWith("bavarium://")) return raw;
  let href = raw;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    href = `https://${href}`;
  }
  try {
    return new URL(href).href;
  } catch (_) {
    return null;
  }
}

function getActiveProxyDisplayName() {
  const s = getSettings();
  if (s.proxyEnabled === false) return null;
  if (s.proxyType === "scramjet") return "Scramjet";
  return "Ultraviolet";
}

function shouldShowProxySiteInfoForUrl(url) {
  const href = resolveSiteInfoHref(url);
  if (!href) return false;
  if (href.startsWith("file://") || href.startsWith("bavarium://")) return false;
  try {
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  } catch (_) {
    return false;
  }
  return !!getActiveProxyDisplayName();
}

function appendSiteInfoSection(container, className, iconSvg, title, description) {
  const section = document.createElement("div");
  section.className = `site-info-section ${className}`;
  const icon = document.createElement("div");
  icon.className = "site-info-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = iconSvg;
  const copy = document.createElement("div");
  copy.className = "site-info-copy";
  const titleEl = document.createElement("p");
  titleEl.className = "site-info-title";
  titleEl.textContent = title;
  const descEl = document.createElement("p");
  descEl.className = "site-info-desc";
  descEl.textContent = description;
  copy.appendChild(titleEl);
  copy.appendChild(descEl);
  section.appendChild(icon);
  section.appendChild(copy);
  container.appendChild(section);
}

function renderSiteInfoPopover(te, kind) {
  const content = document.getElementById("siteInfoPopoverContent");
  if (!content) return;
  content.replaceChildren();

  const displayUrl = te ? tabDisplayUrlForOmnibox(te) : "";
  const href = resolveSiteInfoHref(displayUrl);
  const official = href ? isOfficialReblockSiteUrl(href) : false;
  const proxyName = getActiveProxyDisplayName();

  if (official) {
    appendSiteInfoSection(
      content,
      "site-info-affiliated",
      SITE_INFO_ICONS.verified,
      "Affiliated site",
      "This website is an official ReBlock site and has been optimized for use with Bavarium!"
    );
  }

  if (kind === "https" || kind === "reblock") {
    appendSiteInfoSection(
      content,
      "site-info-secure",
      SITE_INFO_ICONS.shield,
      "This site is secure",
      "Your connection to this site is secure and encrypted with HTTPS."
    );
  } else if (kind === "insecure") {
    appendSiteInfoSection(
      content,
      "site-info-insecure",
      SITE_INFO_ICONS.shield,
      "Connection is not secure",
      "Your connection is not secure and you are at risk. It is recommended you leave this site to avoid your data being at risk."
    );
  } else if (kind === "file") {
    appendSiteInfoSection(
      content,
      "site-info-internal",
      SITE_INFO_ICONS.file,
      "Local file",
      "This page is a file stored on your device."
    );
  } else if (kind === "bavarium") {
    appendSiteInfoSection(
      content,
      "site-info-internal",
      SITE_INFO_ICONS.bavarium,
      "Bavarium page",
      "This is an internal Bavarium page."
    );
  }

  if (shouldShowProxySiteInfoForUrl(displayUrl) && proxyName) {
    appendSiteInfoSection(
      content,
      "site-info-proxy",
      SITE_INFO_ICONS.proxy,
      "Connected via proxy",
      `Active connection to the site is being made through ${proxyName}.`
    );
  }
}

let siteInfoPopoverOpen = false;
let currentSiteInfoKind = null;

function closeSiteInfoPopover() {
  const pop = document.getElementById("siteInfoPopover");
  const btn = document.getElementById("btnSiteInfo");
  if (pop) pop.classList.remove("open");
  if (btn) btn.setAttribute("aria-expanded", "false");
  siteInfoPopoverOpen = false;
}

function updateSiteInfoIndicatorForTab(te) {
  const anchor = document.getElementById("siteInfoAnchor");
  const btn = document.getElementById("btnSiteInfo");
  const iconEl = document.getElementById("siteInfoIcon");
  const contentEl = document.getElementById("siteInfoPopoverContent");
  if (!anchor || !btn || !iconEl || !contentEl) return;

  const active =
    te && currentTab && currentTab.id === te.id && !urlOmniboxUserEditing;
  const kind = active ? classifySiteInfoKind(tabDisplayUrlForOmnibox(te)) : null;

  if (!kind) {
    anchor.hidden = true;
    currentSiteInfoKind = null;
    closeSiteInfoPopover();
    btn.className = "";
    return;
  }

  const info = SITE_INFO_KINDS[kind];
  anchor.hidden = false;
  btn.className = `kind-${kind}`;
  btn.title = info.label;
  btn.setAttribute("aria-label", info.label);
  iconEl.innerHTML = info.icon;
  renderSiteInfoPopover(te, kind);

  if (currentSiteInfoKind !== kind) {
    currentSiteInfoKind = kind;
    closeSiteInfoPopover();
  }
}

function updateUrlBarForTab(te) {
  if (!te || !currentTab || currentTab.id !== te.id) return;
  if (urlOmniboxUserEditing) return;
  const urlInput = document.getElementById("url");
  if (!urlInput) return;
  const displayUrl = tabDisplayUrlForOmnibox(te);
  if (displayUrl) {
    urlInput.value = displayUrl;
    updateSiteInfoIndicatorForTab(te);
    return;
  }
  if (te.view && viewLooksLikeProxyShell(te.view)) {
    updateSiteInfoIndicatorForTab(te);
    return;
  }
  updateSiteInfoIndicatorForTab(te);
}

function attachHoldAltMenuListeners(target) {
  if (!target || target.__bavariumAltMenuListeners) {
    return;
  }
  target.__bavariumAltMenuListeners = true;
  target.addEventListener("keydown", onAltMenuKeyDown, true);
  target.addEventListener("keyup", onAltMenuKeyUp, true);
}

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
    const portBase = `http://localhost:${port}`;
    // Ultraviolet on macOS: hash routing survives shell reloads better than ?url= alone.
    if (settings.proxyType === "ultraviolet") {
      return `${portBase}/bavarium-nav/#url=${encodeURIComponent(url)}`;
    }
    return `${portBase}/?url=${encodeURIComponent(url)}`;
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

function activeProxyPort(settings) {
  if (!settings || settings.proxyEnabled === false) return null;
  if (settings.proxyType !== "ultraviolet" && settings.proxyType !== "scramjet") {
    return null;
  }
  return parseInt(
    String(
      settings.proxyType === "scramjet"
        ? settings.scramjetPort || 3000
        : settings.uvPort || 8080
    ),
    10
  );
}

/** Tab still points at the other proxy's localhost port after a proxy switch. */
function isStaleProxyTabUrl(rawUrl, settings) {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  if (rawUrl.startsWith("bavarium://") || rawUrl.includes("settings.html")) {
    return false;
  }
  if (settings.proxyEnabled === false) return false;
  const loc = parseLocalhostPort(rawUrl);
  if (!loc) return false;
  const active = activeProxyPort(settings);
  if (active === null) return false;
  return loc.port !== active;
}

function resolvedTargetUrlForStaleProxyTab(view, te) {
  const fromGuest = normalizeRemoteUrl(te?.guestPage?.url || "");
  if (fromGuest) return fromGuest;
  const raw = webviewDisplayUrl(view);
  if (!raw) return null;
  const fromShell = proxyShellTargetFromUrl(raw);
  if (fromShell) {
    const inner = normalizeRemoteUrl(fromShell);
    if (inner) return inner;
  }
  return normalizeRemoteUrl(cleanUrl(raw));
}

function remappedUrlForStaleProxyTab(view, te, settings) {
  if (!view || !settings || settings.proxyEnabled === false) return null;
  const raw = webviewDisplayUrl(view);
  if (!raw || !isStaleProxyTabUrl(raw, settings)) return null;

  const target = resolvedTargetUrlForStaleProxyTab(view, te);
  if (target) return wrapUrlForProxyIfNeeded(target, settings);

  if (parseLocalhostPort(raw)) return localProxyBaseUrl(settings);
  return null;
}

/**
 * Reload a tab that still targets the previous proxy's localhost port.
 * @returns {boolean} true if the webview was remapped and reloaded
 */
function refreshStaleProxyTabIfNeeded(te) {
  if (!te?.view) return false;
  const settings = getSettings();
  const newSrc = remappedUrlForStaleProxyTab(te.view, te, settings);
  if (!newSrc) return false;

  let current = "";
  try {
    current = webviewDisplayUrl(te.view);
  } catch (_) {}
  if (current === newSrc) return false;

  te.guestPage = null;
  te.fullTitle = "";
  try {
    forceWebviewNavigation(te.view, newSrc);
  } catch (_) {
    return false;
  }

  if (currentTab && currentTab.id === te.id) {
    try {
      const u = new URL(newSrc);
      const urlInput = document.getElementById("url");
      if (urlInput && u.searchParams.has("url")) {
        urlInput.value = decodeURIComponent(u.searchParams.get("url"));
      } else {
        updateUrlBarForTab(te);
      }
    } catch (_) {
      updateUrlBarForTab(te);
    }
  }

  const titleEl = tabTitleElement(te);
  if (titleEl) {
    applyTabStripLabel(te.view, titleEl, te.incognito, null, null, false);
  }
  refreshTabTooltip(te);
  scheduleGuestTabPageMetaRefresh(te.view);
  return true;
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

const PROXY_LANDING_TITLE_RE =
  /^(scramjet(\s*\|\s*mw)?|ultraviolet(\s*\|\s*sophisticated web proxy)?)$/i;

function isProxyLandingTitle(title) {
  if (!title || typeof title !== "string") return false;
  return PROXY_LANDING_TITLE_RE.test(title.trim());
}

function viewLooksLikeProxyShell(view) {
  const s = getSettings();
  if (s.proxyEnabled === false || !view) return false;
  try {
    const raw = view.getURL ? view.getURL() : view.src || "";
    const u = new URL(raw);
    if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return false;
    const port = parseInt(u.port || "80", 10);
    const expected = parseInt(
      String(
        s.proxyType === "scramjet"
          ? s.scramjetPort || 3000
          : s.uvPort || 8080
      ),
      10
    );
    return port === expected;
  } catch {
    return false;
  }
}

function tabTitleElement(te) {
  if (!te || !te.tab) return null;
  return te.tab.querySelector("span:not(.tab-close)");
}

function applyGuestPageToTab(te, page) {
  if (!te || !page) return;
  let url = page.url && String(page.url).trim() ? String(page.url).trim() : "";
  const normalizedUrl = normalizeRemoteUrl(url);
  if (normalizedUrl) {
    url = normalizedUrl;
  } else if (te.guestPage && te.guestPage.url) {
    url = te.guestPage.url;
  } else {
    url = "";
  }

  let title =
    page.title && String(page.title).trim() ? String(page.title).trim() : "";
  if (title && isProxyLandingTitle(title)) title = "";
  if (title === "Error" && url) {
    try {
      title = new URL(url).hostname || title;
    } catch (_) {}
  }
  if (!title && url) {
    try {
      title = new URL(url).hostname;
    } catch (_) {
      title = "";
    }
  }
  if (!url && !title) return;

  const prev = te.guestPage;
  const urlSame = prev && prev.url === url;
  const titleSame = prev && prev.title === title;
  if (urlSame && titleSame) return;

  let origin = page.origin || "";
  if (!origin && url) {
    try {
      origin = new URL(url).origin;
    } catch (_) {}
  } else if (!origin && prev && prev.origin) {
    origin = prev.origin;
  }

  te.guestPage = {
    url,
    title,
    origin,
    favicon:
      page.favicon ||
      (prev && prev.favicon) ||
      "",
  };
  if (title) te.fullTitle = title;

  const titleEl = tabTitleElement(te);
  if (titleEl && te.view) {
    applyTabStripLabel(
      te.view,
      titleEl,
      te.incognito,
      url || null,
      title || null,
      false
    );
  }
  if (te.faviconImg && te.view) {
    const favList =
      te.guestPage.favicon && /^https?:/i.test(te.guestPage.favicon)
        ? [te.guestPage.favicon]
        : null;
    setTabFaviconImg(te.faviconImg, te.view, url || null, favList);
  }
  refreshTabTooltip(te);
  updateUrlBarForTab(te);
}

function scheduleGuestTabPageMetaRefresh(view) {
  const te = tabEntryForView(view);
  void refreshGuestTabPageMeta(view);
  setTimeout(() => void refreshGuestTabPageMeta(view), 400);
  setTimeout(() => void refreshGuestTabPageMeta(view), 1200);
  if (te) startGuestPageMetaWatcher(te);
}

/** Native tooltip on the tab strip: full page title, incognito explanation. */
function refreshTabTooltip(te) {
  if (!te || !te.tab) return;
  let pageName =
    (te.guestPage && te.guestPage.title && te.guestPage.title.trim()) ||
    (te.fullTitle && te.fullTitle.trim()) ||
    "";
  if (!pageName && te.guestPage && te.guestPage.url) {
    try {
      pageName = new URL(te.guestPage.url).hostname;
    } catch (_) {
      pageName = te.guestPage.url;
    }
  }
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

  const te = tabEntryForView(view);
  if (
    (!faviconUrlList || !faviconUrlList.length) &&
    te &&
    te.guestPage &&
    te.guestPage.favicon &&
    /^https?:/i.test(te.guestPage.favicon)
  ) {
    faviconUrlList = [te.guestPage.favicon];
  }

  let u = navUrl;
  if ((u == null || u === "") && te && te.guestPage && te.guestPage.url) {
    u = te.guestPage.url;
  }
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
  const te = tabEntryForView(view);
  let label = (preferredTitle && String(preferredTitle).trim()) || "";
  if (label && viewLooksLikeProxyShell(view) && isProxyLandingTitle(label)) {
    label = "";
  }

  if (!label && te && te.guestPage && te.guestPage.title) {
    label = te.guestPage.title.trim();
  }

  if (!label && preferExistingTitle) {
    try {
      if (view && view.getTitle) label = (view.getTitle() || "").trim();
    } catch (_) {}
    if (label && viewLooksLikeProxyShell(view) && isProxyLandingTitle(label)) {
      label = "";
    }
  }

  if (!label && navUrl != null && navUrl !== "") {
    const c = cleanUrl(navUrl);
    if (c && !c.includes("localhost") && !c.startsWith("127.0.0.1")) {
      label = (c && c.trim()) || navUrl;
    } else if (te && te.guestPage && te.guestPage.url) {
      try {
        label = new URL(te.guestPage.url).hostname;
      } catch (_) {
        label = te.guestPage.url;
      }
    }
  }

  if (!label) {
    try {
      if (view && view.getTitle) label = (view.getTitle() || "").trim();
    } catch (_) {}
    if (label && viewLooksLikeProxyShell(view) && isProxyLandingTitle(label)) {
      label = "";
    }
  }

  if (!label && te && te.guestPage && te.guestPage.url) {
    try {
      label = new URL(te.guestPage.url).hostname;
    } catch (_) {
      label = te.guestPage.url;
    }
  }

  if (!label) {
    let url = "";
    try {
      if (view && view.getURL) url = view.getURL() || "";
    } catch (_) {}
    if (url) {
      const c = cleanUrl(url);
      if (c && !c.includes("localhost")) {
        label = (c && c.trim()) || url;
      }
    }
  }

  if (label && viewLooksLikeProxyShell(view) && isProxyLandingTitle(label)) {
    label = "";
  }
  if (!label && te && te.guestPage && te.guestPage.title) {
    label = te.guestPage.title.trim();
  }
  if (!label && te && te.guestPage && te.guestPage.url) {
    try {
      label = new URL(te.guestPage.url).hostname;
    } catch (_) {
      label = te.guestPage.url;
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
    /* keep bavarium://newtab — loaded via handleInternal */
  } else if (!url) {
    switch (settings.homepage) {
      case "bavarium":
        url = "bavarium://newtab";
        break;
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
  view.className = "tab-webview";
  attachHoldAltMenuListeners(view);
  attachWebviewBavariumNavigation(view);
  view.setAttribute("partition", incognito ? "incognito" : "persist:bavarium");
  view.setAttribute(
    "webpreferences",
    "nodeIntegration=yes,contextIsolation=no,sandbox=no"
  );
  view.style.display = "none";

  view.addEventListener("dom-ready", () => {
    try {
      const id = view.getWebContentsId();
      const te0 = tabEntryForView(view);
      if (te0) te0.guestWebContentsId = id;
      if (te0 && typeof te0.zoomFactor === "number" && te0.zoomFactor !== 1) {
        applyTabZoom(te0, te0.zoomFactor);
      }
      const wc = webContents?.fromId?.(id);
      if (wc && !wc.isDestroyed() && !wc.__bavariumInternalNavHook) {
        wc.__bavariumInternalNavHook = true;
        wc.on("will-navigate", (event, legacyUrl) => {
          const navUrl =
            (typeof legacyUrl === "string" && legacyUrl) ||
            (event && typeof event.url === "string" ? event.url : "") ||
            "";
          if (navUrl.startsWith("bavarium://")) {
            event.preventDefault();
            handleInternal(navUrl, view);
            return;
          }
          let guestPageUrl = "";
          try {
            guestPageUrl = wc.getURL();
          } catch (_) {}
          if (
            isHttpOrHttpsUrl(navUrl) &&
            isBavariumShellFilePageUrl(guestPageUrl)
          ) {
            event.preventDefault();
            handleShellExternalLink(navUrl, view);
          }
        });
      }
      injectBavariumLinkClickCapture(view);
      injectPageMetaWatcher(view);
      void injectFrameCapOnWebview(view);
      scheduleGuestTabPageMetaRefresh(view);
      const settings = getSettings();
      if (settings.proxyType === "ultraviolet" && viewLooksLikeProxyShell(view)) {
        const inner = proxyShellTargetFromUrl(webviewDisplayUrl(view));
        if (inner) {
          scheduleUltravioletShellNavigation(view, inner);
        }
      }
    } catch (_) {}
  });

  view.addEventListener("page-favicon-updated", (e) => {
    const te0 = tabEntryForView(view);
    if (!te0 || !te0.faviconImg) return;
    if (viewLooksLikeProxyShell(view)) {
      scheduleGuestTabPageMetaRefresh(view);
      return;
    }
    const urls = e.favicons && e.favicons.length ? e.favicons : null;
    setTabFaviconImg(te0.faviconImg, view, null, urls);
  });

  view.addEventListener("page-title-updated", (e) => {
    const te0 = tabEntryForView(view);
    if (viewLooksLikeProxyShell(view)) {
      scheduleGuestTabPageMetaRefresh(view);
      return;
    }
    if (te0) {
      te0.fullTitle = e.title || "";
      refreshTabTooltip(te0);
    }
    applyTabStripLabel(view, title, incognito, null, e.title, false);
    if (te0) updateUrlBarForTab(te0);
    if (viewIsIncognito(view)) return;
    const s = getSettings();
    if (s.historyEnabled === false) return;
    const u = cleanUrl(view.getURL());
    if (!shouldRecordHistoryUrl(u)) return;
    ipcRenderer.send("history-update-title", { url: u, title: e.title });
  });

  view.addEventListener("did-navigate", (e) => {
    const te0 = tabEntryForView(view);
    const settings = getSettings();
    if (te0) {
      if (viewLooksLikeProxyShell(view)) {
        const meta = guestPageMetaFromShellUrl(e.url);
        if (meta) {
          te0.guestPage = meta;
          te0.fullTitle = meta.title || "";
        } else {
          te0.fullTitle = "";
        }
        if (settings.proxyType === "ultraviolet") {
          const inner = proxyShellTargetFromUrl(e.url || "");
          if (inner) {
            scheduleUltravioletShellNavigation(view, inner);
          }
        }
      } else {
        te0.guestPage = null;
      }
      refreshTabTooltip(te0);
    }
    if (te0 && te0.faviconImg) {
      setTabFaviconImg(
        te0.faviconImg,
        view,
        te0.guestPage?.url || e.url,
        null
      );
    }
    applyTabStripLabel(
      view,
      title,
      incognito,
      te0?.guestPage?.url || null,
      te0?.guestPage?.title || null,
      false
    );
    if (te0) updateUrlBarForTab(te0);
    appendHistoryForNavigation(view, e.url);
    scheduleGuestTabPageMetaRefresh(view);
  });

  view.addEventListener("did-navigate-in-page", (e) => {
    const te0 = tabEntryForView(view);
    const settings = getSettings();
    if (te0 && viewLooksLikeProxyShell(view)) {
      const meta = guestPageMetaFromShellUrl(e.url);
      if (meta) {
        te0.guestPage = meta;
        te0.fullTitle = meta.title || "";
      }
      if (settings.proxyType === "ultraviolet") {
        const inner = proxyShellTargetFromUrl(e.url || "");
        if (inner) {
          scheduleUltravioletShellNavigation(view, inner);
        }
      }
      refreshTabTooltip(te0);
    } else if (te0) {
      refreshTabTooltip(te0);
    }
    if (te0 && te0.faviconImg) {
      setTabFaviconImg(
        te0.faviconImg,
        view,
        te0.guestPage?.url || e.url,
        null
      );
    }
    applyTabStripLabel(
      view,
      title,
      incognito,
      te0?.guestPage?.url || null,
      te0?.guestPage?.title || null,
      true
    );
    if (te0) updateUrlBarForTab(te0);
    appendHistoryForNavigation(view, e.url);
    scheduleGuestTabPageMetaRefresh(view);
  });

  view.addEventListener("did-finish-load", () => {
    const te0 = tabEntryForView(view);
    const settingsOnLoad = getSettings();
    if (
      settingsOnLoad.proxyType === "ultraviolet" &&
      viewLooksLikeProxyShell(view)
    ) {
      const innerOnLoad = proxyShellTargetFromUrl(webviewDisplayUrl(view));
      if (innerOnLoad) {
        scheduleUltravioletShellNavigation(view, innerOnLoad);
      }
    }
    try {
      injectPageMetaWatcher(view);
    } catch (_) {}
    let t = "";
    try {
      if (view.getTitle) t = (view.getTitle() || "").trim();
    } catch (_) {}
    if (viewLooksLikeProxyShell(view)) {
      scheduleGuestTabPageMetaRefresh(view);
      return;
    }
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
    if (te0) updateUrlBarForTab(te0);
    scheduleGuestTabPageMetaRefresh(view);
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
    guestPage: null,
    faviconImg,
    zoomFactor: TAB_ZOOM_DEFAULT,
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


const TAB_ZOOM_MIN = 0.25;
const TAB_ZOOM_MAX = 5;
const TAB_ZOOM_STEP = 0.1;
const TAB_ZOOM_DEFAULT = 1;

function shellEditableHasFocus() {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

function applyTabZoom(te, factor) {
  if (!te || !te.view) return TAB_ZOOM_DEFAULT;
  const next = Math.min(
    TAB_ZOOM_MAX,
    Math.max(TAB_ZOOM_MIN, Number(factor) || TAB_ZOOM_DEFAULT)
  );
  te.zoomFactor = next;
  try {
    if (typeof te.view.setZoomFactor === "function") {
      te.view.setZoomFactor(next);
      updateZoomPopoverUI();
      return next;
    }
  } catch (_) {}
  const guestId =
    te.guestWebContentsId ??
    (typeof te.view.getWebContentsId === "function"
      ? te.view.getWebContentsId()
      : null);
  if (guestId != null) {
    void ipcRenderer.invoke("bavarium-set-guest-zoom", {
      webContentsId: guestId,
      factor: next,
    });
  }
  updateZoomPopoverUI();
  return next;
}

function formatZoomPercent(factor) {
  return `${Math.round((Number(factor) || TAB_ZOOM_DEFAULT) * 100)}%`;
}

function currentTabZoomFactor() {
  if (!currentTab) return TAB_ZOOM_DEFAULT;
  return typeof currentTab.zoomFactor === "number"
    ? currentTab.zoomFactor
    : TAB_ZOOM_DEFAULT;
}

function updateZoomPopoverUI() {
  const factor = currentTabZoomFactor();
  const label = formatZoomPercent(factor);
  const pctEl = document.getElementById("zoomPopoverPercent");
  const slider = document.getElementById("zoomPopoverSlider");
  const reset = document.getElementById("zoomPopoverReset");
  const btn = document.getElementById("btnZoom");
  const toolbarLabel = document.getElementById("zoomToolbarLabel");
  if (pctEl) pctEl.textContent = label;
  if (toolbarLabel) toolbarLabel.textContent = label;
  if (btn) btn.setAttribute("title", `Page zoom (${label})`);
  if (slider) {
    const pct = Math.round(
      Math.min(TAB_ZOOM_MAX, Math.max(TAB_ZOOM_MIN, factor)) * 100
    );
    slider.value = String(pct);
  }
  if (reset) {
    reset.disabled = Math.abs(factor - TAB_ZOOM_DEFAULT) < 0.001;
  }
}

function setCurrentTabZoom(factor) {
  return applyTabZoom(currentTab, factor);
}

let zoomPopoverOpen = false;

function closeZoomPopover() {
  const pop = document.getElementById("zoomPopover");
  const btn = document.getElementById("btnZoom");
  if (pop) pop.classList.remove("open");
  if (btn) btn.setAttribute("aria-expanded", "false");
  zoomPopoverOpen = false;
}

function toggleZoomPopover() {
  const pop = document.getElementById("zoomPopover");
  const btn = document.getElementById("btnZoom");
  if (!pop || !btn) return;

  if (zoomPopoverOpen) {
    closeZoomPopover();
    return;
  }

  closeDownloadsShelf();
  closeToolbarMenu();

  updateZoomPopoverUI();
  pop.classList.add("open");
  btn.setAttribute("aria-expanded", "true");
  zoomPopoverOpen = true;
}

function adjustCurrentTabZoom(delta) {
  const te = currentTab;
  if (!te?.view) return TAB_ZOOM_DEFAULT;
  const cur =
    typeof te.zoomFactor === "number" ? te.zoomFactor : TAB_ZOOM_DEFAULT;
  return applyTabZoom(te, cur + delta);
}

function resetCurrentTabZoom() {
  return applyTabZoom(currentTab, TAB_ZOOM_DEFAULT);
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
  tabs.forEach((t) => stopGuestPageMetaWatcher(t.id));
  refreshStaleProxyTabIfNeeded(selected);
  startGuestPageMetaWatcher(selected);
  updateUrlBarForTab(selected);
  updateZoomPopoverUI();
  scheduleGuestTabPageMetaRefresh(selected.view);

  if (document.body.classList.contains("devtools-open") && devtoolsOpenForTabId !== id) {
    attachDevToolsToTab(selected);
  }
  tabFpsPollSeq++;
  lastTabFps = null;
  perfTabPollTick = 5;
  if (perfGraphRafId && perfFpsSamples.length > 8) {
    perfFpsSamples.splice(0, perfFpsSamples.length - 8);
  }
  void refreshTabFpsAfterSwitch(selected);
}

async function refreshTabFpsAfterSwitch(te) {
  const seq = tabFpsPollSeq;
  if (!te || !te.view) return;
  await injectFrameCapOnWebview(te.view);
  if (seq !== tabFpsPollSeq) return;
  const id = await guestWebContentsIdForTab(te);
  if (!id || seq !== tabFpsPollSeq) return;
  try {
    await ipcRenderer.invoke("bavarium-reset-tab-fps-poll", {
      webContentsId: id,
    });
  } catch (_) {}
  if (seq !== tabFpsPollSeq) return;
  scheduleTabFpsPoll(seq);
  setTimeout(() => {
    if (seq === tabFpsPollSeq) scheduleTabFpsPoll(seq);
  }, 120);
  setTimeout(() => {
    if (seq === tabFpsPollSeq) scheduleTabFpsPoll(seq);
  }, 350);
}

function closeTab(id) {
  const index = tabs.findIndex(t => t.id === id);
  if (index === -1) return;

  const tab = tabs[index];
  stopGuestPageMetaWatcher(tab.id);
  if (tab.id === devtoolsOpenForTabId) {
    closeEmbeddedDevTools();
  }
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
  if (!settings.homepage) settings.homepage = "bavarium";
  if (settings.proxyType === "frogies") settings.proxyType = "ultraviolet";
  if (!settings.proxyType) settings.proxyType = "ultraviolet";
  if (!settings.searchEngine) settings.searchEngine = "google";
  if (settings.historyEnabled === undefined) settings.historyEnabled = true;
  if (settings.askBeforeDownload === undefined) settings.askBeforeDownload = true;
  if (settings.proxyEnabled === undefined) settings.proxyEnabled = true;
  if (settings.enableChromiumDevTools === undefined) settings.enableChromiumDevTools = true;
  if (settings.trackPreReleaseUpdates === undefined) settings.trackPreReleaseUpdates = false;
  if (settings.enablePerformanceGraph === undefined) settings.enablePerformanceGraph = false;
  if (settings.fpsLimitEnabled === undefined) settings.fpsLimitEnabled = false;
  if (settings.fpsSyncDisplay === undefined) settings.fpsSyncDisplay = true;
  if (settings.fpsLimit === undefined) settings.fpsLimit = 60;
  if (settings.safeBrowsingEnabled === undefined) settings.safeBrowsingEnabled = true;
  if (
    settings.safeBrowsingProvider !== "google" &&
    settings.safeBrowsingProvider !== "local" &&
    settings.safeBrowsingProvider !== "both"
  ) {
    settings.safeBrowsingProvider = "both";
  }
  if (settings.safeBrowsingApiKey === undefined) settings.safeBrowsingApiKey = "";
  if (
    settings.externalLinkOpenPreference !== "external" &&
    settings.externalLinkOpenPreference !== "bavarium"
  ) {
    settings.externalLinkOpenPreference = "ask";
  }

  return settings;
}

function shouldRecordHistoryUrl(url) {
  if (!url || url.startsWith("file://")) return false;
  if (url.includes("settings.html") || url.includes("newtab.html")) return false;
  if (url.startsWith("bavarium://")) return false;
  return true;
}

function appendHistoryForNavigation(view, rawUrl) {
  if (viewIsIncognito(view)) return;
  const s = getSettings();
  if (s.historyEnabled === false) return;
  const cleaned = cleanUrl(rawUrl);
  if (!shouldRecordHistoryUrl(cleaned)) return;

  let url = cleaned;
  let t = cleaned;
  try {
    if (view.getTitle) t = (view.getTitle() || "").trim() || cleaned;
  } catch (_) {}

  const te = tabEntryForView(view);
  if (te && te.guestPage && te.guestPage.url) {
    url = te.guestPage.url;
    t =
      (te.fullTitle && te.fullTitle.trim()) ||
      (te.guestPage.title && te.guestPage.title.trim()) ||
      t;
  } else if (viewLooksLikeProxyShell(view)) {
    const inner = proxyShellTargetFromUrl(cleaned);
    if (inner) {
      const norm = normalizeRemoteUrl(inner);
      if (norm) {
        url = norm;
        try {
          t = new URL(norm).hostname.replace(/^www\./i, "");
        } catch (_) {}
      }
    }
  }

  if (isProxyLandingTitle(t) || !t) {
    try {
      t = new URL(url).hostname.replace(/^www\./i, "");
    } catch (_) {
      t = url;
    }
  }

  if (!shouldRecordHistoryUrl(url)) return;
  try {
    const u = new URL(url);
    if (
      (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
      !proxyShellTargetFromUrl(url)
    ) {
      return;
    }
  } catch (_) {}

  ipcRenderer.send("history-append", {
    url,
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
  void navigateCurrentTab(input);
}

function isUnsafeWarningPageUrl(pageUrl) {
  if (!pageUrl || typeof pageUrl !== "string") return false;
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== "file:") return false;
    const p = u.pathname.replace(/\\/g, "/").toLowerCase();
    return p.endsWith("/unsafe-warning.html");
  } catch {
    return false;
  }
}

function showUnsafeSiteWarning(te, destination, check) {
  if (!te || !te.view) return;
  const warn = new URL("unsafe-warning.html", window.location.href);
  warn.searchParams.set("target", destination);
  warn.searchParams.set("host", (check && check.host) || "");
  if (check && check.providerLabel) {
    warn.searchParams.set("provider", check.providerLabel);
  }
  if (check && check.threatType) {
    warn.searchParams.set("reason", check.threatType);
  }
  forceWebviewNavigation(te.view, warn.href);
}

function performNavigateToDestination(te, destination, settings) {
  if (te) primeTabGuestPageFromDestination(te, destination);

  const url = wrapUrlForProxyIfNeeded(destination, settings);

  if (isOpposingProxyHomepageUrl(url, settings)) {
    notifyOpposingProxyHomepageBlocked(settings);
    return;
  }

  if (te && te.view) {
    forceWebviewNavigation(te.view, url);
    if (settings.proxyType === "ultraviolet") {
      scheduleUltravioletShellNavigation(te.view, destination);
    }
    scheduleGuestTabPageMetaRefresh(te.view);
  }
}

async function navigateCurrentTab(rawInput, options = {}) {
  const input = String(rawInput || "").trim();
  if (!input) return;

  const settings = getSettings();
  const searchEngine = settings.searchEngine || "google";
  const bypassSafeBrowsing = options.bypassSafeBrowsing === true;

  const resolved = resolveOmniboxInput(input);
  if (!resolved) return;

  if (resolved.kind === "internal") {
    handleInternal(resolved.url);
    return;
  }

  const destination =
    resolved.kind === "url"
      ? resolved.url
      : searchUrlForQuery(resolved.query, searchEngine);

  const te = currentTab;

  if (!bypassSafeBrowsing && settings.safeBrowsingEnabled !== false) {
    try {
      const check = await ipcRenderer.invoke("safe-browsing-check-url", destination);
      if (check && check.blocked) {
        if (te) showUnsafeSiteWarning(te, destination, check);
        return;
      }
    } catch (_) {}
  }

  performNavigateToDestination(te, destination, settings);
}

const BOOKMARKS_KEY = "bavarium-bookmarks";

const DEFAULT_BOOKMARK_ENTRIES = [
  {
    id: "default-bavarium-github",
    title: "GitHub",
    url: "https://github.com/yourworstnightmare1/bavarium-browser",
  },
  {
    id: "default-bavarium-reblock",
    title: "ReBlock Site",
    url: "https://sites.google.com/view/reblock",
  },
];

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

function buildDefaultBookmarksList() {
  return DEFAULT_BOOKMARK_ENTRIES.map((entry) => ({
    id: entry.id,
    title: entry.title,
    url: entry.url,
    faviconUrl: faviconUrlForBookmarkUrl(entry.url),
  }));
}

function loadBookmarks() {
  try {
    const raw = localStorage.getItem(BOOKMARKS_KEY);
    if (raw === null) {
      const defaults = buildDefaultBookmarksList();
      localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(defaults));
      return defaults;
    }
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveBookmarksList(list) {
  localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(list));
  renderBookmarkBar();
}

function setShellModalOpen(open) {
  document.body.classList.toggle("shell-modal-open", !!open);
  document.querySelectorAll("webview.tab-webview.shell-modal-suppressed").forEach((wv) => {
    wv.classList.remove("shell-modal-suppressed");
  });
  const devtoolsHost = document.getElementById("devtoolsHost");
  if (devtoolsHost) devtoolsHost.classList.remove("shell-modal-suppressed");
  if (open) {
    if (currentTab && currentTab.view) {
      currentTab.view.classList.add("shell-modal-suppressed");
    }
    if (devtoolsHost) devtoolsHost.classList.add("shell-modal-suppressed");
  }
}

function normalizeBookmarkMatchUrl(url) {
  if (!url || typeof url !== "string") return "";
  const t = url.trim();
  if (!t) return "";
  try {
    const u = new URL(t);
    let href = u.href;
    if (href.length > 1 && href.endsWith("/")) href = href.slice(0, -1);
    return href;
  } catch (_) {
    return t;
  }
}

function findBookmarkForUrl(url) {
  const key = normalizeBookmarkMatchUrl(url);
  if (!key) return null;
  return (
    loadBookmarks().find(
      (b) => b && normalizeBookmarkMatchUrl(b.url) === key
    ) || null
  );
}

function suggestedBookmarkForCurrentTab() {
  let url = "";
  let title = "";
  const te = currentTab;

  if (te && te.guestPage && te.guestPage.url) {
    const canonical = normalizeRemoteUrl(te.guestPage.url);
    if (canonical) url = canonical;
    title = (te.guestPage.title || te.fullTitle || "").trim();
    if (title && isProxyLandingTitle(title)) title = "";
  }

  if (!url && te && te.view) {
    try {
      const shell = guestPageMetaFromShellUrl(webviewDisplayUrl(te.view));
      if (shell && shell.url) url = shell.url;
      if (!title && shell && shell.title) title = shell.title.trim();
    } catch (_) {}
  }

  if (!url) {
    const urlInput = document.getElementById("url");
    const fromBar = urlInput && urlInput.value ? urlInput.value.trim() : "";
    const canonical = normalizeRemoteUrl(fromBar);
    if (canonical) url = canonical;
  }

  if (!url && te && te.view) {
    try {
      const cleaned = cleanUrl(webviewDisplayUrl(te.view));
      const canonical = normalizeRemoteUrl(cleaned);
      if (canonical) url = canonical;
    } catch (_) {}
  }

  if (!title && te && te.view) {
    try {
      if (te.view.getTitle) title = (te.view.getTitle() || "").trim();
    } catch (_) {}
    if (title && isProxyLandingTitle(title)) title = "";
  }

  if (!title && url) {
    try {
      title = new URL(url).hostname;
    } catch (_) {
      title = "";
    }
  }

  return { url, title };
}

async function resolveSuggestedBookmarkForCurrentTab() {
  if (currentTab && currentTab.view) {
    await refreshGuestTabPageMeta(currentTab.view);
  }
  return suggestedBookmarkForCurrentTab();
}

function applyBookmarkAutofillToInputs(titleIn, urlIn, suggested) {
  if (!titleIn || !urlIn || !suggested) return;
  titleIn.value = suggested.title || "";
  urlIn.value = suggested.url || "";
}

function openBookmarkEditorForCurrentTab() {
  void (async () => {
    const suggested = await resolveSuggestedBookmarkForCurrentTab();
    const existing = suggested.url
      ? findBookmarkForUrl(suggested.url)
      : null;
    if (existing) {
      await openBookmarkEditor(existing.id);
      return;
    }
    await openBookmarkEditor(null, suggested);
  })();
}

let editingBookmarkId = null;

function newBookmarkId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function renderBookmarkBar() {
  const barContainer = document.getElementById("bookmarkbar");
  const bar = document.getElementById("bookmarkbarItems");
  if (!bar) return;
  const items = loadBookmarks().filter((bm) => bm && bm.url);
  if (barContainer) {
    barContainer.classList.toggle("bookmarkbar-empty", items.length === 0);
  }
  bar.innerHTML = "";
  items.forEach((bm) => {
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

let bookmarkAutofillGeneration = 0;

async function openBookmarkEditor(id, preset) {
  const modal = document.getElementById("bookmarkModal");
  const titleIn = document.getElementById("bookmarkEditTitle");
  const urlIn = document.getElementById("bookmarkEditUrl");
  const removeBtn = document.getElementById("bookmarkBtnRemove");
  const modalHeading = document.getElementById("bookmarkModalTitle");
  const autofillHint = document.getElementById("bookmarkAutofillHint");
  const dialog = modal && modal.querySelector(".dialog");
  if (!modal || !titleIn || !urlIn) return;

  const autofillGen = ++bookmarkAutofillGeneration;
  editingBookmarkId = id || null;
  titleIn.disabled = false;
  urlIn.disabled = false;
  titleIn.readOnly = false;
  urlIn.readOnly = false;

  if (id) {
    const bm = loadBookmarks().find((b) => b.id === id);
    if (!bm) return;
    titleIn.value = bm.title || "";
    urlIn.value = bm.url || "";
    if (modalHeading) modalHeading.textContent = "Edit bookmark";
    if (removeBtn) removeBtn.style.display = "";
    if (autofillHint) autofillHint.style.display = "none";
  } else {
    let suggested = preset || suggestedBookmarkForCurrentTab();
    if (!preset || !preset.url) {
      suggested = await resolveSuggestedBookmarkForCurrentTab();
    }
    applyBookmarkAutofillToInputs(titleIn, urlIn, suggested);
    if (modalHeading) modalHeading.textContent = "Add bookmark";
    if (removeBtn) removeBtn.style.display = "none";
    if (autofillHint) {
      autofillHint.style.display = suggested.url ? "block" : "none";
      autofillHint.textContent = suggested.url
        ? "Filled from the current page — you can change the name or URL before saving."
        : "";
    }
    void (async () => {
      const fresh = await resolveSuggestedBookmarkForCurrentTab();
      if (autofillGen !== bookmarkAutofillGeneration) return;
      const userEdited =
        titleIn.value.trim() !== (suggested.title || "").trim() ||
        urlIn.value.trim() !== (suggested.url || "").trim();
      if (!userEdited && fresh.url) {
        applyBookmarkAutofillToInputs(titleIn, urlIn, fresh);
        if (autofillHint) {
          autofillHint.style.display = "block";
          autofillHint.textContent =
            "Filled from the current page — you can change the name or URL before saving.";
        }
      }
    })();
  }

  setShellModalOpen(true);
  modal.style.display = "flex";
  if (dialog && !dialog.__bavariumDialogStop) {
    dialog.__bavariumDialogStop = true;
    dialog.addEventListener("mousedown", (e) => e.stopPropagation());
  }
  requestAnimationFrame(() => {
    titleIn.focus();
    titleIn.select();
  });
}

function closeBookmarkEditor() {
  bookmarkAutofillGeneration++;
  const modal = document.getElementById("bookmarkModal");
  if (modal) modal.style.display = "none";
  setShellModalOpen(false);
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

/** Rebuild proxy URL with ?url= (reload() alone hits the bare proxy home after replaceState). */
function wrappedReloadUrlForTab(te, settings) {
  if (!te?.view || !settings) return null;
  const raw = webviewDisplayUrl(te.view);
  if (raw.startsWith("bavarium://") || raw.includes("settings.html")) {
    return null;
  }

  const remapped = remappedUrlForStaleProxyTab(te.view, te, settings);
  if (remapped) return remapped;

  if (settings.proxyEnabled === false) return null;

  if (viewLooksLikeProxyShell(te.view)) {
    const target = resolvedTargetUrlForStaleProxyTab(te.view, te);
    if (target) return wrapUrlForProxyIfNeeded(target, settings);
    try {
      const u = new URL(raw);
      if (u.searchParams.has("url")) {
        return wrapUrlForProxyIfNeeded(
          decodeURIComponent(u.get("url")),
          settings
        );
      }
    } catch (_) {}
    return localProxyBaseUrl(settings);
  }

  return null;
}

function isLocalProxyShellHref(href) {
  try {
    const u = new URL(href);
    if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
      return false;
    }
    const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
    const onShell = path === "/" || path === "/bavarium-nav";
    if (!onShell) return false;
    return u.searchParams.has("url") || (u.hash && u.hash.includes("url="));
  } catch (_) {
    return false;
  }
}

/** Push a new UV target into an already-loaded shell (macOS often skips full reload). */
function scheduleUltravioletShellNavigation(view, destinationUrl) {
  if (!view || !destinationUrl) return;
  const dest = String(destinationUrl);
  let state = uvShellNavByView.get(view);
  if (!state) {
    state = { dest: "", timer: null };
    uvShellNavByView.set(view, state);
  }
  if (state.dest === dest && state.timer) return;
  state.dest = dest;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    const payload = JSON.stringify(dest);
    const js = `(function() {
      var hash = "url=" + encodeURIComponent(${payload});
      if (location.hash.replace(/^#/, "") === hash) return;
      location.hash = hash;
    })();`;
    webviewGuestExecuteJavaScript(view, js, true).catch(() => {});
  }, 80);
}

/**
 * Assign webview.src in a way that actually reloads on macOS when only the proxy
 * ?url= target changes (same localhost shell — otherwise the old site stays visible
 * while the address bar shows the new destination).
 */
function forceWebviewNavigation(view, href) {
  if (!view || !href) return;
  let current = "";
  try {
    current = webviewDisplayUrl(view);
  } catch (_) {}
  let next = href;
  try {
    const nextU = new URL(href);
    if (isLocalProxyShellHref(href)) {
      let bust = true;
      if (current) {
        try {
          const curU = new URL(current);
          const sameShell =
            curU.hostname === nextU.hostname &&
            (curU.port || "") === (nextU.port || "") &&
            (curU.pathname || "/") === (nextU.pathname || "/");
          const innerChanged =
            proxyShellTargetFromUrl(current) !== proxyShellTargetFromUrl(href);
          if (sameShell && !innerChanged && current !== href) {
            bust = false;
          }
        } catch (_) {}
      }
      if (bust || current === href) {
        // Keep #url= in the hash; bust only adds a query param.
        nextU.searchParams.set("_bavarium_r", String(Date.now()));
        next = nextU.href;
      }
    } else if (current === href) {
      nextU.searchParams.set("_bavarium_r", String(Date.now()));
      next = nextU.href;
    }
  } catch (_) {}
  view.src = next;
}

async function refresh() {
  const te = currentTab;
  if (!te?.view) return;

  const settings = getSettings();
  let newSrc = wrappedReloadUrlForTab(te, settings);

  if (!newSrc && viewLooksLikeProxyShell(te.view)) {
    await refreshGuestTabPageMeta(te.view);
    newSrc = wrappedReloadUrlForTab(te, settings);
  }

  if (newSrc) {
    forceWebviewNavigation(te.view, newSrc);
    if (settings.proxyType === "ultraviolet") {
      try {
        const u = new URL(newSrc);
        if (u.searchParams.has("url")) {
          scheduleUltravioletShellNavigation(
            te.view,
            decodeURIComponent(u.searchParams.get("url"))
          );
        }
      } catch (_) {}
    }
    scheduleGuestTabPageMetaRefresh(te.view);
    if (currentTab && currentTab.id === te.id) {
      try {
        const u = new URL(newSrc);
        if (u.searchParams.has("url")) {
          const inner = normalizeRemoteUrl(
            decodeURIComponent(u.get("url"))
          );
          const urlInput = document.getElementById("url");
          if (urlInput && inner) urlInput.value = inner;
        }
      } catch (_) {}
    }
    return;
  }

  try {
    te.view.reload();
  } catch (_) {}
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
      "about",
      "developer",
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
      about: "about",
      developer: "developer",
    };
    if (hostMap[host]) return hostMap[host];
    return "settings";
  } catch {
    return "settings";
  }
}

function handleInternal(url, targetView) {
  const view = targetView || (currentTab && currentTab.view);
  if (!view) return;
  if (isBavariumNewTabUrl(url)) {
    view.src = new URL("newtab.html", window.location.href).href;
    return;
  }
  const base = new URL("settings.html", window.location.href).href.split("#")[0];
  const hash = bavariumUrlToHash(url);
  view.src = `${base}#${hash}`;
}

function internalPageToBavariumDisplay(fileUrl) {
  try {
    const u = new URL(fileUrl);
    if (u.pathname.endsWith("newtab.html")) return "bavarium://newtab";
  } catch (_) {}
  return settingsFileToBavariumDisplay(fileUrl);
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
      about: "bavarium://about",
      developer: "bavarium://developer",
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
  const pretty = internalPageToBavariumDisplay(url);
  if (pretty) return pretty;
  const inner = proxyShellTargetFromUrl(url);
  if (inner) return inner;
  return url;
}

function guestPageFromProbeResult(te, probePage) {
  if (!probePage) return null;
  const probeUrl = normalizeRemoteUrl(probePage.url || "");
  let probeTitle = (probePage.title || "").trim();
  if (probeTitle && isProxyLandingTitle(probeTitle)) probeTitle = "";
  if (!probeUrl && !probeTitle) return null;
  let title = probeTitle;
  if (!title && probeUrl) {
    try {
      title = new URL(probeUrl).hostname;
    } catch (_) {
      title = "";
    }
  }
  if (!title && te && te.guestPage && te.guestPage.title) {
    title = te.guestPage.title;
  }
  return {
    url: probeUrl || te?.guestPage?.url || "",
    title,
    origin: probePage.origin || "",
    favicon: probePage.favicon || "",
  };
}

async function refreshGuestTabPageMeta(view) {
  if (!view || viewIsIncognito(view)) return;
  const te = tabEntryForView(view);
  if (!te) return;

  let id = null;
  try {
    if (typeof view.getWebContentsId === "function") {
      id = view.getWebContentsId();
    }
  } catch (_) {}
  if (!id) return;

  if (viewLooksLikeProxyShell(view)) {
    try {
      const r = await ipcRenderer.invoke("bavarium-probe-guest-site-page", {
        webContentsId: id,
        refresh: true,
      });
      const page = guestPageFromProbeResult(te, r && r.ok ? r.page : null);
      if (page && (page.url || page.title)) {
        ipcRenderer.send("bavarium-guest-site-page", {
          webContentsId: id,
          page,
        });
        applyGuestPageToTab(te, page);
        return;
      }
    } catch (_) {}
    const raw = webviewDisplayUrl(view);
    const shellPage = guestPageMetaFromShellUrl(raw);
    if (shellPage) {
      ipcRenderer.send("bavarium-guest-site-page", {
        webContentsId: id,
        page: shellPage,
      });
      applyGuestPageToTab(te, shellPage);
    }
    return;
  }

  if (!viewLooksLikeProxyShell(view)) {
    let t = "";
    try {
      if (view.getTitle) t = (view.getTitle() || "").trim();
    } catch (_) {}
    if (t && !isProxyLandingTitle(t)) {
      te.fullTitle = t;
      const titleEl = tabTitleElement(te);
      if (titleEl) {
        applyTabStripLabel(view, titleEl, te.incognito, null, t, false);
      }
      refreshTabTooltip(te);
    }
    updateUrlBarForTab(te);
  }
}

let downloadsShelfOpen = false;

function escapeShelfHtml(text) {
  const d = document.createElement("div");
  d.textContent = text == null ? "" : String(text);
  return d.innerHTML;
}

function formatShelfBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function downloadShelfStateLabel(row) {
  if (row.active) {
    if (row.state === "interrupted") return "Failed";
    if (row.totalBytes > 0) {
      const pct = Math.min(
        100,
        Math.round((row.receivedBytes / row.totalBytes) * 100)
      );
      return `${pct}% · ${formatShelfBytes(row.receivedBytes)} / ${formatShelfBytes(row.totalBytes)}`;
    }
    if (row.receivedBytes > 0) {
      return `${formatShelfBytes(row.receivedBytes)} downloaded`;
    }
    return "In progress…";
  }
  if (row.state === "completed") return "Completed";
  if (row.state === "cancelled") return "Cancelled";
  if (row.state === "interrupted") return "Failed";
  return row.state ? String(row.state) : "";
}

function closeDownloadsShelf() {
  const pop = document.getElementById("downloadsPopover");
  const btn = document.getElementById("btnDownloads");
  if (pop) pop.classList.remove("open");
  if (btn) btn.setAttribute("aria-expanded", "false");
  downloadsShelfOpen = false;
}

function closeToolbarMenu() {
  const menu = document.getElementById("menu");
  if (menu) menu.style.display = "none";
}

async function refreshDownloadsShelf() {
  const listEl = document.getElementById("downloadsShelfList");
  const btn = document.getElementById("btnDownloads");
  if (!listEl) return;

  let payload = { active: [], recent: [] };
  try {
    payload = await ipcRenderer.invoke("get-downloads-shelf");
  } catch (_) {}

  const active = Array.isArray(payload.active) ? payload.active : [];
  const recent = Array.isArray(payload.recent) ? payload.recent : [];
  const activePaths = new Set(
    active.map((r) => (r.path || "").trim()).filter(Boolean)
  );
  const rows = [
    ...active,
    ...recent
      .filter((r) => {
        const p = (r.path || "").trim();
        return !p || !activePaths.has(p);
      })
      .slice(0, 5),
  ];

  if (btn) {
    btn.classList.toggle("has-active", active.length > 0);
  }

  if (!rows.length) {
    listEl.innerHTML =
      '<div class="downloads-shelf-empty">No recent downloads</div>';
    return;
  }

  const iconSrc = "assets/menu-icons/downloads.png";
  listEl.innerHTML = rows
    .map((row) => {
      const name = escapeShelfHtml(row.name || "Download");
      const meta = escapeShelfHtml(downloadShelfStateLabel(row));
      let progress = "";
      if (row.active && row.totalBytes > 0) {
        const pct = Math.min(
          100,
          Math.round((row.receivedBytes / row.totalBytes) * 100)
        );
        progress = `<div class="downloads-shelf-progress" aria-hidden="true"><span style="width:${pct}%"></span></div>`;
      } else if (row.active) {
        progress =
          '<div class="downloads-shelf-progress" aria-hidden="true"><span style="width:35%"></span></div>';
      }
      const pathEnc = encodeURIComponent(row.path || "");
      return `<button type="button" class="downloads-shelf-row" role="listitem" data-active="${row.active ? "1" : "0"}" data-path="${pathEnc}" data-state="${escapeShelfHtml(row.state || "")}">
        <img class="downloads-shelf-icon" src="${iconSrc}" width="20" height="20" alt="" aria-hidden="true" />
        <div class="downloads-shelf-body">
          <div class="downloads-shelf-name">${name}</div>
          <div class="downloads-shelf-meta">${meta}</div>
          ${progress}
        </div>
      </button>`;
    })
    .join("");

  listEl.querySelectorAll(".downloads-shelf-row").forEach((rowBtn) => {
    rowBtn.addEventListener("click", () => {
      const isActive = rowBtn.getAttribute("data-active") === "1";
      const enc = rowBtn.getAttribute("data-path");
      const filePath = enc ? decodeURIComponent(enc) : "";
      const state = rowBtn.getAttribute("data-state") || "";
      closeDownloadsShelf();
      if (!isActive && filePath && state === "completed") {
        void ipcRenderer.invoke("reveal-download", filePath);
        return;
      }
      newTab("bavarium://downloads");
    });
  });
}

function toggleDownloadsShelf() {
  const pop = document.getElementById("downloadsPopover");
  const btn = document.getElementById("btnDownloads");
  if (!pop || !btn) return;

  if (downloadsShelfOpen) {
    closeDownloadsShelf();
    closeToolbarMenu();
    return;
  }

  closeZoomPopover();
  closeToolbarMenu();

  pop.classList.add("open");
  btn.setAttribute("aria-expanded", "true");
  downloadsShelfOpen = true;
  void refreshDownloadsShelf();
}

function openDownloadManagerFromShelf() {
  closeDownloadsShelf();
  newTab("bavarium://downloads");
}

function toggleMenu() {
  closeDownloadsShelf();
  closeZoomPopover();
  const menu = document.getElementById("menu");
  if (!menu) return;
  menu.style.display = menu.style.display === "block" ? "none" : "block";
}

function getShareablePageUrl() {
  if (!currentTab || !currentTab.view) return null;
  const url = cleanUrl(webviewDisplayUrl(currentTab.view));
  if (!url || url.startsWith("bavarium://") || url.startsWith("file://")) {
    return null;
  }
  return url;
}

async function shareCurrentPage() {
  closeToolbarMenu();
  const url = getShareablePageUrl();
  if (!url) {
    alert("This page cannot be shared.");
    return;
  }
  let title = "";
  try {
    if (currentTab.view.getTitle) {
      title = (currentTab.view.getTitle() || "").trim();
    }
  } catch (_) {}
  const result = await ipcRenderer.invoke("bavarium-share-page", { url, title });
  if (result && result.method === "clipboard") {
    alert("Native share is unavailable on this system. Page link copied to the clipboard.");
  }
}

function initDevToolsHost() {
  const host = document.getElementById("devtoolsHost");
  if (!host) return;
  const captureId = () => {
    try {
      const id = host.getWebContentsId();
      if (id) devtoolsHostWebContentsId = id;
    } catch (_) {}
  };
  host.addEventListener("dom-ready", captureId, { once: true });
  if (host.getWebContentsId) captureId();
}

function showEmbeddedDevToolsPanel() {
  document.body.classList.add("devtools-open");
}

function hideEmbeddedDevToolsPanel() {
  document.body.classList.remove("devtools-open");
  devtoolsOpenForTabId = null;
}

async function ensureDevToolsHostReady() {
  if (devtoolsHostWebContentsId) return devtoolsHostWebContentsId;
  const host = document.getElementById("devtoolsHost");
  if (!host) return null;
  return new Promise((resolve) => {
    const done = () => resolve(devtoolsHostWebContentsId);
    if (devtoolsHostWebContentsId) {
      done();
      return;
    }
    host.addEventListener("dom-ready", done, { once: true });
    setTimeout(done, 500);
  });
}

async function guestWebContentsIdForTab(te) {
  if (!te || !te.view) return null;
  if (te.guestWebContentsId) return te.guestWebContentsId;
  try {
    if (typeof te.view.getWebContentsId === "function") {
      const id = te.view.getWebContentsId();
      if (id) {
        te.guestWebContentsId = id;
        return id;
      }
    }
  } catch (_) {}
  return null;
}

function tabForGuestWebContentsId(webContentsId) {
  const id = Number(webContentsId);
  if (!Number.isFinite(id)) return null;
  for (const te of tabs) {
    if (te.guestWebContentsId === id) return te;
    try {
      if (te.view && te.view.getWebContentsId?.() === id) {
        te.guestWebContentsId = id;
        return te;
      }
    } catch (_) {}
  }
  return null;
}

async function saveCurrentTabPageAs() {
  const te = currentTab;
  if (!te || !te.view) return;
  const guestId = await guestWebContentsIdForTab(te);
  if (!guestId) return;
  await ipcRenderer.invoke("bavarium-save-page-as", { webContentsId: guestId });
}

async function attachDevToolsToTab(te) {
  const hostId = await ensureDevToolsHostReady();
  const guestId = await guestWebContentsIdForTab(te);
  if (!hostId || !guestId) return false;
  for (const t of tabs) {
    if (t.id === te.id) continue;
    const otherId = await guestWebContentsIdForTab(t);
    if (!otherId) continue;
    try {
      await ipcRenderer.invoke("bavarium-open-devtools", {
        webContentsId: otherId,
        close: true,
      });
    } catch (_) {}
  }
  const result = await ipcRenderer.invoke("bavarium-open-devtools", {
    webContentsId: guestId,
    devtoolsHostWebContentsId: hostId,
  });
  if (result && result.ok) {
    showEmbeddedDevToolsPanel();
    devtoolsOpenForTabId = te.id;
    return true;
  }
  console.warn("attachDevToolsToTab:", result);
  return false;
}

async function closeEmbeddedDevTools() {
  const te = tabs.find((t) => t.id === devtoolsOpenForTabId) || currentTab;
  const guestId = te ? await guestWebContentsIdForTab(te) : null;
  if (guestId) {
    try {
      await ipcRenderer.invoke("bavarium-open-devtools", {
        webContentsId: guestId,
        close: true,
      });
    } catch (_) {}
  }
  hideEmbeddedDevToolsPanel();
}

async function openCurrentTabDevTools() {
  closeToolbarMenu();
  if (getSettings().enableChromiumDevTools === false) {
    return;
  }
  const te = currentTab;
  if (!te || !te.view) return;

  if (
    document.body.classList.contains("devtools-open") &&
    devtoolsOpenForTabId === te.id
  ) {
    await closeEmbeddedDevTools();
    return;
  }

  const run = async () => {
    if (await attachDevToolsToTab(te)) return;
    const guestId = await guestWebContentsIdForTab(te);
    if (!guestId) return;
    const result = await ipcRenderer.invoke("bavarium-open-devtools", {
      webContentsId: guestId,
    });
    if (result && result.ok) {
      if (result.detached) {
        console.warn("DevTools opened in a separate window (embed unavailable).");
      }
    }
  };

  const guestId = await guestWebContentsIdForTab(te);
  if (guestId) {
    await run();
  } else {
    te.view.addEventListener("dom-ready", () => run(), { once: true });
  }
}

function closeBookmarkManager() {
  const modal = document.getElementById("bookmarkManagerModal");
  if (modal) modal.style.display = "none";
  const bmModal = document.getElementById("bookmarkModal");
  if (!bmModal || bmModal.style.display !== "flex") {
    setShellModalOpen(false);
  }
}

function renderBookmarkManagerList() {
  const listEl = document.getElementById("bookmarkManagerList");
  if (!listEl) return;
  listEl.innerHTML = "";
  const items = loadBookmarks();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "bm-manager-empty";
    empty.textContent = "No bookmarks yet. Use Add bookmark to create one.";
    listEl.appendChild(empty);
    return;
  }
  items.forEach((bm) => {
    const row = document.createElement("div");
    row.className = "bm-manager-row";
    row.title = bm.url;

    const textCol = document.createElement("div");
    textCol.style.flex = "1";
    textCol.style.minWidth = "0";

    const nameEl = document.createElement("div");
    nameEl.className = "bm-mgr-label";
    nameEl.textContent = bm.title || bm.url;

    const urlEl = document.createElement("div");
    urlEl.className = "bm-mgr-url";
    urlEl.textContent = bm.url;

    textCol.appendChild(nameEl);
    textCol.appendChild(urlEl);
    row.appendChild(textCol);

    row.addEventListener("click", () => {
      closeBookmarkManager();
      openBookmarkEditor(bm.id);
    });

    listEl.appendChild(row);
  });
}

function openBookmarkManager() {
  closeToolbarMenu();
  const modal = document.getElementById("bookmarkManagerModal");
  if (!modal) return;
  renderBookmarkManagerList();
  setShellModalOpen(true);
  modal.style.display = "flex";
  const dialog = modal.querySelector(".dialog");
  if (dialog && !dialog.__bavariumDialogStop) {
    dialog.__bavariumDialogStop = true;
    dialog.addEventListener("mousedown", (e) => e.stopPropagation());
  }
}

function handleToolbarMenuAction(action) {
  closeToolbarMenu();
  switch (action) {
    case "settings":
      newTab("bavarium://settings");
      break;
    case "history":
      newTab("bavarium://history");
      break;
    case "bookmark-manager":
      openBookmarkManager();
      break;
    case "downloads":
      newTab("bavarium://downloads");
      break;
    case "share-page":
      shareCurrentPage();
      break;
    case "developer-tools":
      openCurrentTabDevTools();
      break;
    case "github-repo":
      shell.openExternal(GITHUB_REPO_URL);
      break;
    default:
      break;
  }
}

// close menu when clicking outside
document.addEventListener("click", (e) => {
  const menu = document.getElementById("menu");
  if (!menu) return;

  if (
    !e.target.closest("#menu") &&
    !e.target.closest("#btnToolbarMenu")
  ) {
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
      : settings.homepage || "bavarium";
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
    trackPreReleaseUpdates: settings.trackPreReleaseUpdates === true,
    enableChromiumDevTools: settings.enableChromiumDevTools !== false,
    enablePerformanceGraph: settings.enablePerformanceGraph === true,
    fpsLimitEnabled: settings.fpsLimitEnabled === true,
    fpsSyncDisplay: settings.fpsSyncDisplay !== false,
    fpsLimit: normalizeFpsLimitSetting(settings.fpsLimit),
    safeBrowsingEnabled: settings.safeBrowsingEnabled !== false,
    safeBrowsingProvider:
      settings.safeBrowsingProvider === "google" ||
      settings.safeBrowsingProvider === "local"
        ? settings.safeBrowsingProvider
        : "both",
    safeBrowsingApiKey: settings.safeBrowsingApiKey || "",
    externalLinkOpenPreference:
      settings.externalLinkOpenPreference === "external" ||
      settings.externalLinkOpenPreference === "bavarium"
        ? settings.externalLinkOpenPreference
        : "ask",
  };
  localStorage.setItem("settings", JSON.stringify(merged));
  syncDeveloperUiFromSettings(merged);
  applyFrameRateCapToAllWebviews();
}

let frameRateCapState = {
  limitEnabled: false,
  syncDisplay: true,
  displayHz: 60,
  effectiveCap: null,
};

/** Upper bound for perf overlay readings (configured cap or display refresh). */
function perfFpsCeiling() {
  if (
    frameRateCapState.limitEnabled &&
    frameRateCapState.effectiveCap > 0
  ) {
    return frameRateCapState.effectiveCap;
  }
  const hz = frameRateCapState.displayHz;
  return Number.isFinite(hz) && hz > 0 ? hz : 240;
}

function clampPerfFps(fps) {
  if (!Number.isFinite(fps)) return fps;
  const ceil = perfFpsCeiling();
  return Math.max(0, Math.min(ceil, fps));
}

function onPerfGraphIntervalGap() {
  if (!perfGraphRafId) return;
  lastTabFps = null;
  perfTabPollTick = 5;
  const te = currentTab;
  if (!te || !te.guestWebContentsId) return;
  ipcRenderer
    .invoke("bavarium-reset-tab-fps-poll", {
      webContentsId: te.guestWebContentsId,
    })
    .catch(() => {});
}

function normalizeFpsLimitSetting(raw) {
  const n = parseInt(String(raw ?? 60), 10);
  if (!Number.isFinite(n)) return 60;
  const maxHz =
    frameRateCapState.displayHz && frameRateCapState.displayHz > 0
      ? frameRateCapState.displayHz
      : 240;
  return Math.max(1, Math.min(maxHz, n));
}

async function injectFrameCapOnWebview(view) {
  if (!view) return;
  let id = null;
  try {
    if (typeof view.getWebContentsId === "function") {
      id = view.getWebContentsId();
    }
  } catch (_) {}
  if (!id) return;
  try {
    await ipcRenderer.invoke("bavarium-inject-frame-cap", { webContentsId: id });
  } catch (_) {}
}

function applyFrameRateCapToAllWebviews() {
  document.querySelectorAll("webview.tab-webview").forEach((v) => {
    void injectFrameCapOnWebview(v);
  });
}

let perfGraphRafId = null;
let perfGraphNetTimer = null;
let lastTabFps = null;
let perfTabPollTick = 0;
let tabFpsPollSeq = 0;
const perfFpsSamples = [];
const perfShellFpsSamples = [];
const perfDownSamples = [];
const perfUpSamples = [];
const PERF_SAMPLE_MAX = 48;

function formatPerfRate(kbs) {
  if (kbs >= 1024) return `${(kbs / 1024).toFixed(1)} MB/s`;
  return `${kbs} KB/s`;
}

const PERF_FPS_TARGET = 60;
const PERF_FPS_GREEN = { r: 129, g: 201, b: 149 };
const PERF_FPS_RED = { r: 242, g: 139, b: 130 };

/** Green at target FPS+; smooth blend toward red below target. */
function perfFpsColorTarget() {
  if (frameRateCapState.limitEnabled && frameRateCapState.effectiveCap > 0) {
    return frameRateCapState.effectiveCap;
  }
  return PERF_FPS_TARGET;
}

function fpsColorForValue(fps) {
  const target = perfFpsColorTarget();
  if (!Number.isFinite(fps) || fps >= target) {
    return "rgb(129, 201, 149)";
  }
  const t = Math.max(0, Math.min(1, fps / target));
  const r = Math.round(PERF_FPS_RED.r + (PERF_FPS_GREEN.r - PERF_FPS_RED.r) * t);
  const g = Math.round(PERF_FPS_RED.g + (PERF_FPS_GREEN.g - PERF_FPS_RED.g) * t);
  const b = Math.round(PERF_FPS_RED.b + (PERF_FPS_GREEN.b - PERF_FPS_RED.b) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

function applyFpsColor(el, fps) {
  if (!el) return;
  el.style.color = fpsColorForValue(fps);
}

function fpsLowHighAverages(samples) {
  if (!samples.length) return { low: null, high: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.max(1, Math.floor(sorted.length / 2));
  const lowHalf = sorted.slice(0, mid);
  const highHalf = sorted.slice(mid);
  const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  return {
    low: avg(lowHalf),
    high: avg(highHalf.length ? highHalf : lowHalf),
  };
}

function drawPerfSparkline(canvas, samples, color, scaleMax) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!samples.length) return;
  const max = Math.max(scaleMax || perfFpsCeiling(), ...samples, 1);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  samples.forEach((v, i) => {
    const x = (i / Math.max(1, PERF_SAMPLE_MAX - 1)) * (w - 2) + 1;
    const y = h - 2 - (v / max) * (h - 4);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function stopPerformanceGraph() {
  if (perfGraphRafId) {
    cancelAnimationFrame(perfGraphRafId);
    perfGraphRafId = null;
  }
  if (perfGraphNetTimer) {
    clearInterval(perfGraphNetTimer);
    perfGraphNetTimer = null;
  }
  const overlay = document.getElementById("perfOverlay");
  if (overlay) {
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");
  }
  perfFpsSamples.length = 0;
  perfShellFpsSamples.length = 0;
  perfDownSamples.length = 0;
  perfUpSamples.length = 0;
  lastTabFps = null;
}

function scheduleTabFpsPoll(expectedSeq) {
  const pollSeq = expectedSeq != null ? expectedSeq : tabFpsPollSeq;
  const te = currentTab;
  if (!te || !te.guestWebContentsId) {
    if (pollSeq === tabFpsPollSeq) lastTabFps = null;
    return;
  }
  const id = te.guestWebContentsId;
  ipcRenderer
    .invoke("bavarium-poll-tab-fps", { webContentsId: id })
    .then((r) => {
      if (pollSeq !== tabFpsPollSeq) return;
      if (!currentTab || currentTab.guestWebContentsId !== id) return;
      if (r && r.ok && r.fps != null && Number.isFinite(r.fps) && r.fps > 0) {
        lastTabFps = clampPerfFps(r.fps);
      }
    })
    .catch(() => {});
}

function perfGraphLoop(lastTs) {
  const now = performance.now();
  if (lastTs) {
    const dtMs = now - lastTs;
    if (dtMs <= 250) {
      const minDtMs = 1000 / perfFpsCeiling();
      const shellFps = clampPerfFps(1000 / Math.max(dtMs, minDtMs));
      perfShellFpsSamples.push(shellFps);
      if (perfShellFpsSamples.length > PERF_SAMPLE_MAX) perfShellFpsSamples.shift();

      if (++perfTabPollTick % 6 === 0) {
        scheduleTabFpsPoll();
      }

      const te = currentTab;
      const tabReady = te && te.guestWebContentsId;
      const graphFps = clampPerfFps(
        tabReady && lastTabFps != null ? lastTabFps : shellFps
      );
      const graphSource = tabReady && lastTabFps != null ? "Tab" : "UI";

      perfFpsSamples.push(graphFps);
      if (perfFpsSamples.length > PERF_SAMPLE_MAX) perfFpsSamples.shift();

      const fpsEl = document.getElementById("perfFpsLabel");
      if (fpsEl) {
        const capNote =
          frameRateCapState.limitEnabled && frameRateCapState.effectiveCap
            ? ` / ${frameRateCapState.effectiveCap}`
            : "";
        fpsEl.textContent = `${graphSource} ${Math.round(graphFps)}${capNote}`;
        applyFpsColor(fpsEl, graphFps);
      }
      const uiEl = document.getElementById("perfUiFpsLabel");
      if (uiEl) {
        if (tabReady && lastTabFps != null) {
          uiEl.textContent = `UI ${Math.round(shellFps)}`;
          uiEl.style.display = "";
        } else {
          uiEl.textContent = "";
          uiEl.style.display = "none";
        }
      }
      const { low, high } = fpsLowHighAverages(perfFpsSamples);
      const lowEl = document.getElementById("perfFpsLow");
      const highEl = document.getElementById("perfFpsHigh");
      if (lowEl) {
        lowEl.textContent =
          low != null && Number.isFinite(low) ? `↓ ${Math.round(low)}` : "↓ —";
        applyFpsColor(lowEl, low != null ? low : 0);
      }
      if (highEl) {
        highEl.textContent =
          high != null && Number.isFinite(high)
            ? `↑ ${Math.round(high)}`
            : "↑ —";
        applyFpsColor(highEl, high != null ? high : PERF_FPS_TARGET);
      }
      drawPerfSparkline(
        document.getElementById("perfCanvasFps"),
        perfFpsSamples,
        fpsColorForValue(graphFps),
        perfFpsCeiling()
      );
    } else {
      onPerfGraphIntervalGap();
    }
  }
  perfGraphRafId = requestAnimationFrame(() => perfGraphLoop(now));
}

function startPerformanceGraph() {
  const s = getSettings();
  if (s.enablePerformanceGraph !== true) {
    stopPerformanceGraph();
    return;
  }
  const overlay = document.getElementById("perfOverlay");
  if (!overlay) return;
  overlay.hidden = false;
  overlay.setAttribute("aria-hidden", "false");
  if (!perfGraphRafId) perfGraphLoop(0);
  if (!perfGraphNetTimer) {
    const pollNet = async () => {
      try {
        const st = await ipcRenderer.invoke("bavarium-perf-network-stats");
        const down = st && Number.isFinite(st.downKBs) ? st.downKBs : 0;
        const up = st && Number.isFinite(st.upKBs) ? st.upKBs : 0;
        perfDownSamples.push(down);
        perfUpSamples.push(up);
        if (perfDownSamples.length > PERF_SAMPLE_MAX) perfDownSamples.shift();
        if (perfUpSamples.length > PERF_SAMPLE_MAX) perfUpSamples.shift();
        const netEl = document.getElementById("perfNetLabel");
        if (netEl) {
          netEl.textContent = `↓ ${formatPerfRate(down)}  ↑ ${formatPerfRate(up)}`;
        }
        const netCanvas = document.getElementById("perfCanvasNet");
        const combined = perfDownSamples.map((d, i) => d + (perfUpSamples[i] || 0));
        drawPerfSparkline(netCanvas, combined, "#81c995");
      } catch (_) {}
    };
    pollNet();
    perfGraphNetTimer = setInterval(pollNet, 500);
  }
}

function syncDeveloperUiFromSettings(settings) {
  const s = settings || getSettings();
  const devItem = document.querySelector('[data-menu-action="developer-tools"]');
  if (devItem) {
    const enabled = s.enableChromiumDevTools !== false;
    devItem.classList.toggle("disabled", !enabled);
    devItem.setAttribute("aria-disabled", enabled ? "false" : "true");
  }
  if (s.enablePerformanceGraph === true) startPerformanceGraph();
  else stopPerformanceGraph();
}

window.onload = async () => {
  attachHoldAltMenuListeners(window);
  attachHoldAltMenuListeners(document);
  window.addEventListener("blur", () => setAltMenuBarHeld(false));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") onPerfGraphIntervalGap();
  });
  window.addEventListener("blur", onPerfGraphIntervalGap);

  ipcRenderer.on("bavarium-protocol-navigate", (_e, url) => {
    if (typeof url === "string" && url.startsWith("bavarium://")) {
      handleInternal(url);
    }
  });

  try {
    const fileSettings = await ipcRenderer.invoke("get-settings");
    applySettingsPayload(fileSettings);
    syncDeveloperUiFromSettings(fileSettings);
    try {
      const fr = await ipcRenderer.invoke("get-frame-rate-settings");
      if (fr) frameRateCapState = fr;
      applyFrameRateCapToAllWebviews();
    } catch (_) {}
  } catch (e) {
    console.warn("get-settings failed:", e);
  }

  initTabStripContainer();
  initDevToolsHost();

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
    btnAddBm.addEventListener("click", () => openBookmarkEditorForCurrentTab());
  }

  const btnZoom = document.getElementById("btnZoom");
  const zoomOut = document.getElementById("zoomPopoverOut");
  const zoomIn = document.getElementById("zoomPopoverIn");
  const zoomSlider = document.getElementById("zoomPopoverSlider");
  const zoomReset = document.getElementById("zoomPopoverReset");
  if (btnZoom) {
    btnZoom.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleZoomPopover();
    });
  }
  if (zoomOut) {
    zoomOut.addEventListener("click", (e) => {
      e.stopPropagation();
      adjustCurrentTabZoom(-TAB_ZOOM_STEP);
    });
  }
  if (zoomIn) {
    zoomIn.addEventListener("click", (e) => {
      e.stopPropagation();
      adjustCurrentTabZoom(TAB_ZOOM_STEP);
    });
  }
  if (zoomSlider) {
    zoomSlider.addEventListener("input", () => {
      const pct = Number(zoomSlider.value);
      if (!Number.isFinite(pct)) return;
      setCurrentTabZoom(pct / 100);
    });
  }
  if (zoomReset) {
    zoomReset.addEventListener("click", (e) => {
      e.stopPropagation();
      resetCurrentTabZoom();
    });
  }
  document.addEventListener("click", (e) => {
    if (!zoomPopoverOpen) return;
    const anchor = document.getElementById("zoomAnchor");
    if (anchor && !anchor.contains(e.target)) {
      closeZoomPopover();
    }
  });
  updateZoomPopoverUI();

  const btnSiteInfo = document.getElementById("btnSiteInfo");
  if (btnSiteInfo) {
    btnSiteInfo.addEventListener("click", (e) => {
      e.stopPropagation();
      const pop = document.getElementById("siteInfoPopover");
      if (!pop) return;
      if (siteInfoPopoverOpen) {
        closeSiteInfoPopover();
        return;
      }
      if (currentTab && currentSiteInfoKind) {
        renderSiteInfoPopover(currentTab, currentSiteInfoKind);
      }
      closeZoomPopover();
      closeDownloadsShelf();
      pop.classList.add("open");
      btnSiteInfo.setAttribute("aria-expanded", "true");
      siteInfoPopoverOpen = true;
    });
  }
  document.addEventListener("click", (e) => {
    if (!siteInfoPopoverOpen) return;
    const anchor = document.getElementById("siteInfoAnchor");
    if (anchor && !anchor.contains(e.target)) {
      closeSiteInfoPopover();
    }
  });

  const btnDownloads = document.getElementById("btnDownloads");
  const downloadsOpenManager = document.getElementById("downloadsShelfOpenManager");
  if (btnDownloads) {
    btnDownloads.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDownloadsShelf();
    });
  }
  if (downloadsOpenManager) {
    downloadsOpenManager.addEventListener("click", (e) => {
      e.stopPropagation();
      openDownloadManagerFromShelf();
    });
  }
  document.addEventListener("click", (e) => {
    if (!downloadsShelfOpen) return;
    const anchor = document.getElementById("downloadsAnchor");
    if (anchor && !anchor.contains(e.target)) {
      closeDownloadsShelf();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && downloadsShelfOpen) {
      closeDownloadsShelf();
    }
    if (e.key === "Escape" && zoomPopoverOpen) {
      closeZoomPopover();
    }
    if (e.key === "Escape" && siteInfoPopoverOpen) {
      closeSiteInfoPopover();
    }
  });
  void refreshDownloadsShelf();
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
      return;
    }
    const ext = document.getElementById("externalLinkModal");
    if (ext && ext.style.display === "flex") {
      e.preventDefault();
      closeExternalLinkModal();
    }
  });

  const urlInput = document.getElementById("url");
  if (urlInput) {
    urlInput.addEventListener("focus", () => {
      urlOmniboxUserEditing = true;
    });
    urlInput.addEventListener("blur", () => {
      urlOmniboxUserEditing = false;
      if (currentTab) updateSiteInfoIndicatorForTab(currentTab);
    });
    urlInput.addEventListener("input", () => {
      urlOmniboxUserEditing = true;
    });
    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        urlOmniboxUserEditing = false;
        go();
      }
    });
  }

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
      case "zoom-in":
        adjustCurrentTabZoom(TAB_ZOOM_STEP);
        break;
      case "zoom-out":
        adjustCurrentTabZoom(-TAB_ZOOM_STEP);
        break;
      case "zoom-reset":
        resetCurrentTabZoom();
        break;
      case "find-in-page":
        openFindInPage();
        break;
      case "bookmark-page":
        openBookmarkEditorForCurrentTab();
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
      case "developer":
        newTab("bavarium://developer");
        break;
      default:
        break;
    }
  });

  ipcRenderer.on("bavarium-devtools-hotkey", async (_e, payload) => {
    const id = payload && payload.webContentsId;
    const te = tabForGuestWebContentsId(id) || currentTab;
    if (!te || !te.view) return;
    if (te.id !== currentTab?.id) {
      switchTab(te.id);
    }
    await openCurrentTabDevTools();
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
    void (async () => {
      const settings = getSettings();
      if (settings.safeBrowsingEnabled !== false) {
        try {
          const check = await ipcRenderer.invoke("safe-browsing-check-url", url);
          if (check && check.blocked) {
            const te = newTab(null, { background, incognito });
            showUnsafeSiteWarning(te, url, check);
            return;
          }
        } catch (_) {}
      }
      const te = newTab(null, { background, incognito });
      performNavigateToDestination(te, url, settings);
    })();
  });

  ipcRenderer.on("bavarium-unsafe-site-blocked", (_e, payload) => {
    const url = payload && payload.url;
    if (!url) return;
    let te = currentTab;
    if (payload && payload.openInNewTab) {
      te = newTab(null, {
        background: !!payload.background,
        incognito: !!payload.incognito,
      });
    }
    if (te) showUnsafeSiteWarning(te, url, payload);
  });

  ipcRenderer.on("bavarium-shell-external-link", (_e, payload) => {
    const url =
      payload && typeof payload === "object" && typeof payload.url === "string"
        ? payload.url
        : "";
    if (!url) return;
    handleShellExternalLink(url, currentTab && currentTab.view, {
      background: !!(payload && payload.background),
      incognito: !!(payload && payload.incognito),
    });
  });

  const externalLinkModal = document.getElementById("externalLinkModal");
  const externalLinkOpenExternal = document.getElementById("externalLinkOpenExternal");
  const externalLinkOpenBavarium = document.getElementById("externalLinkOpenBavarium");
  if (externalLinkOpenExternal) {
    externalLinkOpenExternal.addEventListener("click", () => {
      completeExternalLinkModal("external");
    });
  }
  if (externalLinkOpenBavarium) {
    externalLinkOpenBavarium.addEventListener("click", () => {
      completeExternalLinkModal("bavarium");
    });
  }
  if (externalLinkModal) {
    externalLinkModal.addEventListener("click", (e) => {
      if (e.target === externalLinkModal) closeExternalLinkModal();
    });
  }

  document.addEventListener("keydown", (e) => {
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const ctrl = isMac ? e.metaKey : e.ctrlKey;

  if (!ctrl) return;

  const key = e.key.toLowerCase();

  if (
    !document.body.classList.contains("shell-modal-open") &&
    !e.shiftKey &&
    !e.altKey &&
    key === "s"
  ) {
    e.preventDefault();
    void saveCurrentTabPageAs();
    return;
  }

  if (
    e.shiftKey &&
    !e.altKey &&
    key === "i" &&
    !document.body.classList.contains("shell-modal-open") &&
    getSettings().enableChromiumDevTools !== false
  ) {
    e.preventDefault();
    void openCurrentTabDevTools();
    return;
  }

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

  if (
    !e.altKey &&
    !document.body.classList.contains("shell-modal-open") &&
    (key === "=" || key === "+" || key === "-")
  ) {
    if (!shellEditableHasFocus()) {
      e.preventDefault();
      if (key === "-") {
        adjustCurrentTabZoom(-TAB_ZOOM_STEP);
      } else {
        adjustCurrentTabZoom(TAB_ZOOM_STEP);
      }
    }
    return;
  }

  if (
    !e.altKey &&
    key === "0" &&
    !document.body.classList.contains("shell-modal-open")
  ) {
    if (!shellEditableHasFocus()) {
      e.preventDefault();
      resetCurrentTabZoom();
    }
    return;
  }

  if (key === "f") {
    e.preventDefault();
    openFindInPage();
    return;
  }

  if (key === "d") {
    e.preventDefault();
    openBookmarkEditorForCurrentTab();
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

  document.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (document.body.classList.contains("shell-modal-open")) return;
      if (shellEditableHasFocus()) return;
      if (!currentTab?.view) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? TAB_ZOOM_STEP : -TAB_ZOOM_STEP;
      adjustCurrentTabZoom(delta);
    },
    { passive: false, capture: true }
  );

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

  ipcRenderer.on("bavarium-frame-rate-settings", (_e, state) => {
    if (state && typeof state === "object") {
      frameRateCapState = state;
      applyFrameRateCapToAllWebviews();
    }
  });

  ipcRenderer.on("settings-updated", (_e, settings) => {
    applySettingsPayload(settings || undefined);
    if (currentTab) {
      refreshStaleProxyTabIfNeeded(currentTab);
      updateSiteInfoIndicatorForTab(currentTab);
    }
    document.querySelectorAll("webview").forEach((wv) => {
      const src = wv.getAttribute("src") || "";
      if (src.includes("settings.html")) {
        wv.executeJavaScript(
          "window.__bavariumRefreshHistory && window.__bavariumRefreshHistory()"
        ).catch(() => {});
        wv.executeJavaScript(
          "window.__bavariumRefreshDeveloper && window.__bavariumRefreshDeveloper()"
        ).catch(() => {});
      }
    });
  });

  ipcRenderer.on("downloads-updated", () => {
    void refreshDownloadsShelf();
    document.querySelectorAll("webview").forEach((wv) => {
      const src = wv.getAttribute("src") || "";
      if (
        src.includes("settings.html") ||
        src.startsWith("bavarium://downloads")
      ) {
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

  ipcRenderer.on("proxy-port-state", (_e, state) => {
    if (state && state.settings) {
      applySettingsPayload(state.settings);
    }
  });

  ipcRenderer.on("proxy-switched", () => {
    tabs.forEach((t) => refreshStaleProxyTabIfNeeded(t));
    if (currentTab) {
      updateUrlBarForTab(currentTab);
      scheduleGuestTabPageMetaRefresh(currentTab.view);
    }
  });

  const menuEl = document.getElementById("menu");
  if (menuEl) {
    menuEl.addEventListener("click", (e) => {
      const item = e.target.closest("[data-menu-action]");
      if (!item || item.classList.contains("disabled")) return;
      e.stopPropagation();
      handleToolbarMenuAction(item.dataset.menuAction);
    });
  }

  const bmMgrModal = document.getElementById("bookmarkManagerModal");
  const bmMgrAdd = document.getElementById("bookmarkManagerAdd");
  const bmMgrClose = document.getElementById("bookmarkManagerClose");
  if (bmMgrAdd) {
    bmMgrAdd.addEventListener("click", () => {
      closeBookmarkManager();
      openBookmarkEditorForCurrentTab();
    });
  }
  if (bmMgrClose) bmMgrClose.addEventListener("click", closeBookmarkManager);
  if (bmMgrModal) {
    bmMgrModal.addEventListener("click", (e) => {
      if (e.target === bmMgrModal) closeBookmarkManager();
    });
  }
};
