"use strict";

const path = require("path");
const { ipcRenderer } = require("electron");

function applyVersionLabel() {
  const el = document.getElementById("appVersionLabel");
  if (!el) return;
  try {
    const pkg = require(path.join(__dirname, "package.json"));
    el.textContent = pkg.bavariumDisplayVersion || `v${pkg.version}`;
  } catch {
    el.textContent = "v2.0b";
  }
}

/** Mirrors persisted settings (including fields not in every form section). */
let currentSettings = {};

async function loadSettingsFromMain() {
  currentSettings = await ipcRenderer.invoke("get-settings");
  return currentSettings;
}

function syncIconSelectFromHidden(wrap) {
  if (!wrap) return;
  const hidden = wrap.querySelector('input[type="hidden"]');
  if (!hidden) return;
  const val = hidden.value;
  const triggerImg = wrap.querySelector(".icon-select-trigger-img");
  const triggerText = wrap.querySelector(".icon-select-trigger-text");
  const opt = Array.from(wrap.querySelectorAll(".icon-select-option")).find(
    (b) => b.dataset.value === val
  );
  if (!opt || !triggerImg || !triggerText) return;
  const srcImg = opt.querySelector("img");
  const label = opt.querySelector(".icon-select-label");
  if (srcImg) triggerImg.src = srcImg.src;
  if (label) triggerText.textContent = label.textContent;
  wrap.querySelectorAll(".icon-select-option").forEach((b) => {
    b.classList.toggle("is-selected", b.dataset.value === val);
  });
}

function closeIconSelect(wrap) {
  if (!wrap) return;
  const panel = wrap.querySelector(".icon-select-panel");
  const trigger = wrap.querySelector(".icon-select-trigger");
  if (panel) panel.hidden = true;
  if (trigger) trigger.setAttribute("aria-expanded", "false");
  wrap.classList.remove("is-open");
}

function openIconSelect(wrap) {
  if (!wrap) return;
  const panel = wrap.querySelector(".icon-select-panel");
  const trigger = wrap.querySelector(".icon-select-trigger");
  if (panel) panel.hidden = false;
  if (trigger) trigger.setAttribute("aria-expanded", "true");
  wrap.classList.add("is-open");
}

function wireIconSelect(wrap, onChange) {
  const trigger = wrap.querySelector(".icon-select-trigger");
  const panel = wrap.querySelector(".icon-select-panel");
  if (!trigger || !panel) return;
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = wrap.classList.contains("is-open");
    document.querySelectorAll("[data-icon-select].is-open").forEach((w) => {
      closeIconSelect(w);
    });
    if (!wasOpen) openIconSelect(wrap);
  });
  panel.querySelectorAll(".icon-select-option").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const v = btn.dataset.value;
      if (!v) return;
      const hidden = wrap.querySelector('input[type="hidden"]');
      hidden.value = v;
      syncIconSelectFromHidden(wrap);
      closeIconSelect(wrap);
      if (onChange) onChange(v);
    });
  });
}

let portStatusTimer = null;
let applySettingsTimer = null;
let settingsFormReady = false;

function setSaveStatus(text) {
  const el = document.getElementById("saveStatus");
  if (el) el.textContent = text || "";
}

function scheduleApplySettings(options = {}) {
  if (!settingsFormReady) return;
  const { delay = 400, silent = true } = options;
  if (applySettingsTimer) clearTimeout(applySettingsTimer);
  applySettingsTimer = setTimeout(() => {
    applySettingsTimer = null;
    void applySettingsNow({ silent });
  }, delay);
}

async function applySettingsNow({ silent = true } = {}) {
  const next = collectSettingsFromForm();
  const proxyChanged =
    next.proxyType !== currentSettings.proxyType ||
    next.uvPort !== currentSettings.uvPort ||
    next.scramjetPort !== currentSettings.scramjetPort ||
    next.transport !== currentSettings.transport ||
    next.wssServer !== (currentSettings.wssServer || "") ||
    next.proxyEnabled !== currentSettings.proxyEnabled;

  currentSettings = next;
  ipcRenderer.send("save-settings", next);
  if (proxyChanged) ipcRenderer.send("change-proxy", next);

  schedulePortStatusCheck();
  updateLicensePortLinks();
  await refreshFpsDisplayHint();

  if (!silent) {
    alert("Settings saved.");
  } else {
    setSaveStatus("Saved");
    setTimeout(() => {
      if (document.getElementById("saveStatus")?.textContent === "Saved") {
        setSaveStatus("");
      }
    }, 2000);
  }
}

function installAutoApplySettings() {
  const schedule = () => scheduleApplySettings({ silent: true });
  const scheduleDebounced = () => scheduleApplySettings({ delay: 500, silent: true });

  [
    "transport",
    "wssServer",
    "proxyEnabled",
    "historyEnabled",
    "askBeforeDownload",
    "trackPreReleaseUpdates",
    "enableChromiumDevTools",
    "enablePerformanceGraph",
    "fpsLimitEnabled",
    "fpsSyncDisplay",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", schedule);
  });

  ["uvPort", "scramjetPort", "fpsLimit"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", scheduleDebounced);
    el.addEventListener("input", () => {
      if (id === "fpsLimit") clampFpsLimitInput();
      scheduleDebounced();
      if (id === "uvPort" || id === "scramjetPort") {
        schedulePortStatusCheck();
        updateLicensePortLinks();
      }
    });
  });
}

/** URL hash fragment → sidebar section id (DOM: section-{id}) */
const HASH_TO_NAV = {
  settings: "proxy",
  proxy: "proxy",
  browsing: "browsing",
  history: "privacy",
  privacy: "privacy",
  downloads: "downloads",
  about: "about",
  developer: "developer",
};

let cachedDisplayHz = 60;

const LICENSE_HASHES = new Set([
  "licenses",
  "licenses-ultraviolet",
  "licenses-scramjet",
]);

function updateLicensePortLinks() {
  const uv = document.getElementById("licenseUvPortLink");
  const sj = document.getElementById("licenseSjPortLink");
  const pUv = String(currentSettings.uvPort ?? "8080").replace(/[^\d]/g, "") || "8080";
  const pSj =
    String(currentSettings.scramjetPort ?? "3000").replace(/[^\d]/g, "") || "3000";
  if (uv) {
    uv.href = `http://127.0.0.1:${pUv}/LICENSE`;
    uv.textContent = `http://127.0.0.1:${pUv}/LICENSE`;
  }
  if (sj) {
    sj.href = `http://127.0.0.1:${pSj}/LICENSE`;
    sj.textContent = `http://127.0.0.1:${pSj}/LICENSE`;
  }
}

function showSection(hashId) {
  let hid = hashId;
  if (!HASH_TO_NAV[hid] && !LICENSE_HASHES.has(hid)) {
    hid = "settings";
  }

  if (LICENSE_HASHES.has(hid)) {
    document.body.classList.add("license-only-page");
    document.querySelectorAll(".section").forEach((el) => {
      const sid = el.id.replace(/^section-/, "");
      el.classList.toggle("active", sid === hid);
    });
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.classList.remove("active");
    });
    if (window.location.hash !== "#" + hid) {
      history.replaceState(null, "", "#" + hid);
    }
    if (hid === "licenses-scramjet") document.title = "Scramjet — License";
    else if (hid === "licenses-ultraviolet") document.title = "Ultraviolet — License";
    else if (hid === "licenses") document.title = "Third-party licenses";
    updateLicensePortLinks();
    if (hid === "licenses") renderThirdPartyLicenseTables();
    return;
  }

  document.body.classList.remove("license-only-page");
  document.title = "Settings";

  const nav = HASH_TO_NAV[hid];

  document.querySelectorAll(".section").forEach((el) => {
    const sid = el.id.replace(/^section-/, "");
    el.classList.toggle("active", sid === nav);
  });

  document.querySelectorAll(".nav-item").forEach((btn) => {
    const h = btn.dataset.hash;
    const btnNav = HASH_TO_NAV[h];
    const active =
      btnNav === nav &&
      (h === hid ||
        (nav === "proxy" && hid === "settings" && h === "proxy") ||
        (nav === "privacy" &&
          (hid === "privacy" || hid === "history") &&
          (h === "history" || h === "privacy")));
    btn.classList.toggle("active", active);
  });

  if (window.location.hash !== "#" + hid) {
    history.replaceState(null, "", "#" + hid);
  }

  if (nav === "proxy") schedulePortStatusCheck();
  if (nav === "downloads") void renderDownloads();
  if (nav === "privacy") {
    void renderHistory();
    void renderSitePermissions();
  }
  if (nav === "about") {
    void renderAboutBrowser();
  }
  if (nav === "developer") {
    void renderFrameworkVersions();
    void refreshFpsDisplayHint();
  }
}

function applyHashFromLocation() {
  let h = (window.location.hash || "").replace(/^#/, "") || "settings";
  if (!HASH_TO_NAV[h] && !LICENSE_HASHES.has(h)) h = "settings";
  showSection(h);
}

function setPortStatusLine(el, text, kind) {
  if (!el) return;
  el.textContent = text;
  el.className = "port-status " + (kind || "neutral");
}

function applyPortCheckResult(el, r, proxyLabel) {
  if (!r || !el) return;
  if (!r.ok) {
    setPortStatusLine(el, r.message, "bad");
    return;
  }
  if (r.message) {
    setPortStatusLine(el, r.message, "warn");
    return;
  }
  if (r.inUse == null) {
    setPortStatusLine(el, "Could not verify port.", "warn");
    return;
  }
  if (r.inUse && r.isOurProxy) {
    setPortStatusLine(
      el,
      `Port is in use by the running ${proxyLabel} proxy (expected).`,
      "ok"
    );
    return;
  }
  if (r.inUse) {
    let msg =
      "Port is already in use — choose another port or stop the other program.";
    if (r.suggestedPort != null && r.suggestedPort !== r.port) {
      msg += ` Try ${r.suggestedPort} (next available).`;
    }
    setPortStatusLine(el, msg, "bad");
    return;
  }
  setPortStatusLine(el, "Port is available.", "ok");
}

async function refreshProxyPortStatuses() {
  const uvEl = document.getElementById("uvPortStatus");
  const sjEl = document.getElementById("scramjetPortStatus");
  const uvVal = document.getElementById("uvPort").value;
  const sjVal = document.getElementById("scramjetPort").value;
  try {
    const [uv, sj] = await Promise.all([
      ipcRenderer.invoke("check-proxy-port", { port: uvVal, which: "uv" }),
      ipcRenderer.invoke("check-proxy-port", { port: sjVal, which: "sj" }),
    ]);
    applyPortCheckResult(uvEl, uv, "Ultraviolet");
    applyPortCheckResult(sjEl, sj, "Scramjet");
  } catch {
    setPortStatusLine(uvEl, "Could not check ports.", "warn");
    setPortStatusLine(sjEl, "Could not check ports.", "warn");
  }
}

function schedulePortStatusCheck() {
  clearTimeout(portStatusTimer);
  portStatusTimer = setTimeout(() => refreshProxyPortStatuses(), 320);
}

function syncProxyFieldsVisibility() {
  const pt =
    document.getElementById("proxyType")?.value.trim() || "ultraviolet";
  const showLocal = pt === "ultraviolet" || pt === "scramjet";
  document.querySelectorAll("[data-local-proxy-only]").forEach((el) => {
    el.style.display = showLocal ? "" : "none";
  });
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "";
  }
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function normalizeLicenseField(lic) {
  if (lic == null || lic === "") return "—";
  if (typeof lic === "string") return lic;
  if (Array.isArray(lic)) {
    const parts = lic
      .map((x) =>
        typeof x === "object" && x && x.type ? String(x.type) : String(x)
      )
      .filter(Boolean);
    return parts.length ? parts.join(", ") : "—";
  }
  if (typeof lic === "object" && lic.type) return String(lic.type);
  return "—";
}

function readInstalledPackageMeta(baseDir, depName) {
  const parts = depName.split("/");
  const pkgPath = path.join(baseDir, "node_modules", ...parts, "package.json");
  try {
    const j = require(pkgPath);
    return {
      name: j.name || depName,
      version: j.version || "",
      license: normalizeLicenseField(j.license || j.licenses),
    };
  } catch {
    return {
      name: depName,
      version: "",
      license: "—",
    };
  }
}

function collectDependencyRows(relDir) {
  const root = path.join(__dirname, relDir);
  let pkg;
  try {
    pkg = require(path.join(root, "package.json"));
  } catch {
    return [];
  }
  const refs = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };
  const rows = [];
  for (const depName of Object.keys(refs).sort((a, b) => a.localeCompare(b))) {
    const requested = String(refs[depName] || "");
    const meta = readInstalledPackageMeta(root, depName);
    rows.push({ ...meta, requested });
  }
  return rows;
}

function renderThirdPartyLicenseTables() {
  const mount = document.getElementById("thirdPartyLicensesMount");
  const meta = document.getElementById("thirdPartyLicensesMeta");
  if (!mount) return;

  const bundles = [
    {
      title: "Bavarium Browser",
      rel: "",
      note: "Electron shell and build tooling (package.json dependencies).",
    },
    {
      title: "Ultraviolet app (bundled)",
      rel: "ultraviolet-app",
      note: "Local Ultraviolet proxy stack bundled with Bavarium.",
    },
    {
      title: "Scramjet app (bundled)",
      rel: "scramjet-app",
      note: "Local Scramjet proxy stack bundled with Bavarium.",
    },
  ];

  const parts = [];
  for (const b of bundles) {
    const rows = collectDependencyRows(b.rel);
    const tableRows = rows
      .map(
        (r) => `
      <tr>
        <td>${escapeHtml(r.name)}</td>
        <td class="mono">${escapeHtml(r.version || "—")}</td>
        <td class="mono">${escapeHtml(r.requested)}</td>
        <td>${escapeHtml(r.license)}</td>
      </tr>`
      )
      .join("");
    parts.push(
      `<h3 class="license-bundle-head">${escapeHtml(b.title)}</h3>` +
        `<p class="license-deps-meta" style="margin:0 0 12px">${escapeHtml(
          b.note
        )}</p>` +
        `<table class="license-deps-table" aria-label="${escapeHtml(
          b.title
        )} dependencies">
      <thead><tr><th>Package</th><th>Installed</th><th>Requested</th><th>License</th></tr></thead>
      <tbody>${
        tableRows ||
        '<tr><td colspan="4">No dependencies listed in package.json.</td></tr>'
      }</tbody>
    </table>`
    );
  }
  mount.innerHTML = parts.join("");
  if (meta) {
    meta.textContent =
      "Bavarium’s own SPDX license is ISC (see repository package.json). License cells use each package’s package.json when the dependency is installed under that folder’s node_modules.";
  }
}

function applySettingsToForm() {
  const s = currentSettings;
  const proxyH = document.getElementById("proxyType");
  if (proxyH) proxyH.value = s.proxyType || "ultraviolet";
  syncIconSelectFromHidden(document.getElementById("proxyTypeIconSelect"));
  document.getElementById("transport").value = s.transport || "epoxy";
  document.getElementById("wssServer").value = s.wssServer || "";
  document.getElementById("proxyEnabled").checked = s.proxyEnabled !== false;
  document.getElementById("uvPort").value = s.uvPort || "8080";
  document.getElementById("scramjetPort").value = s.scramjetPort || "3000";
  const homeH = document.getElementById("homepage");
  if (homeH) homeH.value = s.homepage || "bavarium";
  syncIconSelectFromHidden(document.getElementById("homepageIconSelect"));
  const seH = document.getElementById("searchEngine");
  if (seH) seH.value = s.searchEngine || "google";
  syncIconSelectFromHidden(document.getElementById("searchEngineIconSelect"));
  document.getElementById("historyEnabled").checked = s.historyEnabled !== false;
  document.getElementById("askBeforeDownload").checked =
    s.askBeforeDownload !== false;
  const trackPre = document.getElementById("trackPreReleaseUpdates");
  if (trackPre) trackPre.checked = s.trackPreReleaseUpdates === true;
  const devTools = document.getElementById("enableChromiumDevTools");
  if (devTools) devTools.checked = s.enableChromiumDevTools !== false;
  const perfGraph = document.getElementById("enablePerformanceGraph");
  if (perfGraph) perfGraph.checked = s.enablePerformanceGraph === true;
  const fpsLimitEnabled = document.getElementById("fpsLimitEnabled");
  if (fpsLimitEnabled) fpsLimitEnabled.checked = s.fpsLimitEnabled === true;
  const fpsSyncDisplay = document.getElementById("fpsSyncDisplay");
  if (fpsSyncDisplay) fpsSyncDisplay.checked = s.fpsSyncDisplay !== false;
  const fpsLimit = document.getElementById("fpsLimit");
  if (fpsLimit) {
    fpsLimit.value = String(s.fpsLimit ?? 60);
    fpsLimit.max = String(cachedDisplayHz);
  }
  syncFpsSettingsUi();
  void refreshFpsDisplayHint();
  syncProxyFieldsVisibility();
  syncAboutPrereleaseUi();
}

function collectSettingsFromForm() {
  return {
    ...currentSettings,
    searchEngine:
      document.getElementById("searchEngine").value.trim() || "google",
    proxyType: document.getElementById("proxyType").value.trim() || "ultraviolet",
    transport: document.getElementById("transport").value,
    wssServer: document.getElementById("wssServer").value,
    proxyEnabled: document.getElementById("proxyEnabled").checked,
    uvPort: document.getElementById("uvPort").value,
    scramjetPort: document.getElementById("scramjetPort").value,
    homepage: document.getElementById("homepage").value.trim() || "bavarium",
    historyEnabled: document.getElementById("historyEnabled").checked,
    askBeforeDownload: document.getElementById("askBeforeDownload").checked,
    downloadPath: currentSettings.downloadPath || "",
    trackPreReleaseUpdates: !!document.getElementById("trackPreReleaseUpdates")?.checked,
    enableChromiumDevTools: !!document.getElementById("enableChromiumDevTools")?.checked,
    enablePerformanceGraph: !!document.getElementById("enablePerformanceGraph")?.checked,
    fpsLimitEnabled: !!document.getElementById("fpsLimitEnabled")?.checked,
    fpsSyncDisplay: !!document.getElementById("fpsSyncDisplay")?.checked,
    fpsLimit: clampFpsLimitValue(
      parseInt(document.getElementById("fpsLimit")?.value || "60", 10)
    ),
  };
}

function clampFpsLimitValue(raw) {
  const hz = cachedDisplayHz || 60;
  let v = parseInt(String(raw), 10);
  if (!Number.isFinite(v)) v = Math.min(60, hz);
  return Math.max(1, Math.min(hz, v));
}

function clampFpsLimitInput() {
  const el = document.getElementById("fpsLimit");
  if (!el) return;
  const hz = cachedDisplayHz || 60;
  el.max = String(hz);
  el.min = "1";
  const clamped = clampFpsLimitValue(el.value);
  if (String(clamped) !== el.value) {
    el.value = String(clamped);
  }
}

async function refreshFpsDisplayHint() {
  const hint = document.getElementById("fpsDisplayHzHint");
  const effective = document.getElementById("fpsEffectiveHint");
  let hz = 60;
  try {
    const r = await ipcRenderer.invoke("get-display-refresh-rate");
    if (r && Number.isFinite(r.hz)) hz = r.hz;
  } catch (_) {}
  cachedDisplayHz = hz;
  clampFpsLimitInput();
  if (hint) hint.textContent = `Primary display: ${hz} Hz (max FPS cannot exceed this)`;
  try {
    const state = await ipcRenderer.invoke("get-frame-rate-settings");
    if (effective && state) {
      if (!state.limitEnabled) {
        effective.textContent = state.syncDisplay
          ? "No cap — tied to display refresh (VSync on)."
          : "No cap — VSync off (restart if you changed sync).";
      } else {
        effective.textContent = state.syncDisplay
          ? `Page cap: ${state.effectiveCap} FPS (VSync on — restart if you changed sync).`
          : `Page cap: ${state.effectiveCap} FPS (VSync off — restart if needed).`;
      }
    }
  } catch (_) {}
}

function syncFpsSettingsUi() {
  const limitOn = !!document.getElementById("fpsLimitEnabled")?.checked;
  const syncOn = !!document.getElementById("fpsSyncDisplay")?.checked;
  const fpsLimit = document.getElementById("fpsLimit");
  if (fpsLimit) {
    fpsLimit.disabled = !limitOn;
    if (limitOn) clampFpsLimitInput();
  }
  const syncEl = document.getElementById("fpsSyncDisplay");
  if (syncEl && syncEl.parentElement) {
    syncEl.parentElement.style.opacity = limitOn ? "1" : "0.55";
  }
  if (fpsLimit) {
    fpsLimit.style.opacity = limitOn ? "1" : "0.55";
  }
  const eff = document.getElementById("fpsEffectiveHint");
  if (eff && !limitOn) {
    eff.textContent = syncOn
      ? "No frame cap — pages run at display refresh when VSync is on."
      : "No frame cap.";
  }
}

async function refreshDownloadPathLabel() {
  const el = document.getElementById("downloadPathDisplay");
  if (!el) return;
  const custom = (currentSettings.downloadPath || "").trim();
  if (custom) {
    el.textContent = custom;
    return;
  }
  try {
    const def = await ipcRenderer.invoke("get-default-downloads-path");
    el.textContent = def || "(System Downloads folder)";
  } catch {
    el.textContent = "(System Downloads folder)";
  }
}

async function renderHistory() {
  const container = document.getElementById("historyList");
  if (!container) return;
  let items = [];
  try {
    items = await ipcRenderer.invoke("get-browsing-history");
  } catch {
    items = [];
  }
  if (!items.length) {
    container.innerHTML =
      '<p class="empty-hint">No history yet. Browse with “Save browsing history” enabled.</p>';
    return;
  }
  container.innerHTML = items
    .map(
      (h, i) => `
    <div class="history-row" data-index="${i}">
      <div>
        <div class="history-title">${escapeHtml(h.title || h.url)}</div>
        <div class="history-url">${escapeHtml(h.url)}</div>
        <div class="history-meta">${formatTime(h.ts)}</div>
      </div>
      <button type="button" class="btn secondary history-delete" data-index="${i}">Remove</button>
    </div>`
    )
    .join("");
  container.querySelectorAll(".history-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = parseInt(btn.dataset.index, 10);
      await ipcRenderer.invoke("delete-browsing-history-item", idx);
      await renderHistory();
    });
  });
}

let sitePermissionTypesCache = [];

async function renderSitePermissions() {
  const container = document.getElementById("sitePermissionsList");
  if (!container) return;
  let data = { sites: [], permissionTypes: [] };
  try {
    data = await ipcRenderer.invoke("get-site-permissions");
  } catch (e) {
    console.warn("get-site-permissions:", e);
  }
  sitePermissionTypesCache = data.permissionTypes || [];
  const types = sitePermissionTypesCache;
  const sites = data.sites || [];

  if (!sites.length) {
    container.innerHTML =
      '<p class="empty-hint">No site permission rules yet. Add a site above, or choose “Always allow/block” when a site asks for access.</p>';
    return;
  }

  container.innerHTML = sites
    .map((site, siteIdx) => {
      const selects = types
        .map((t, typeIdx) => {
          const rule = (site.rules && site.rules[t.id]) || "ask";
          const sid = `perm-${siteIdx}-${typeIdx}`;
          return `
        <label for="${sid}">${escapeHtml(t.label)}</label>
        <select id="${sid}" class="site-perm-select" data-origin="${escapeHtml(site.origin)}" data-permission="${escapeHtml(t.id)}">
          <option value="ask"${rule === "ask" ? " selected" : ""}>Ask every time</option>
          <option value="allow"${rule === "allow" ? " selected" : ""}>Allow</option>
          <option value="block"${rule === "block" ? " selected" : ""}>Block</option>
        </select>`;
        })
        .join("");
      return `
    <div class="site-perm-card" data-origin="${escapeHtml(site.origin)}">
      <div class="site-perm-head">
        <div>
          <div class="site-perm-host">${escapeHtml(site.hostname || site.origin)}</div>
          <div class="site-perm-origin">${escapeHtml(site.origin)}</div>
        </div>
        <button type="button" class="btn secondary site-perm-remove" data-origin="${escapeHtml(site.origin)}">Remove site</button>
      </div>
      <div class="site-perm-grid">${selects}</div>
    </div>`;
    })
    .join("");

  container.querySelectorAll(".site-perm-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const origin = sel.dataset.origin;
      const permission = sel.dataset.permission;
      const rule = sel.value;
      try {
        await ipcRenderer.invoke("set-site-permission", { origin, permission, rule });
      } catch (e) {
        alert("Could not update permission: " + (e && e.message ? e.message : String(e)));
        await renderSitePermissions();
      }
    });
  });

  container.querySelectorAll(".site-perm-remove").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const origin = btn.dataset.origin;
      if (!origin) return;
      if (!confirm(`Remove all permission rules for ${origin}?`)) return;
      await ipcRenderer.invoke("remove-site-permissions", { origin });
      await renderSitePermissions();
    });
  });
}

function syncAboutPrereleaseUi() {
  const preBtn = document.getElementById("checkPrereleaseBuildsBtn");
  if (!preBtn) return;
  preBtn.hidden = currentSettings.trackPreReleaseUpdates !== true;
}

async function renderAboutBrowser() {
  syncAboutPrereleaseUi();
  const appNameEl = document.getElementById("aboutAppName");
  const browserVerEl = document.getElementById("aboutBrowserVersion");
  const electronEl = document.getElementById("aboutElectronVersion");
  const commitRow = document.getElementById("aboutLatestCommitRow");
  const commitCell = document.getElementById("aboutLatestCommit");
  try {
    const info = await ipcRenderer.invoke("get-about-browser-info");
    if (appNameEl) appNameEl.textContent = info.appName || "—";
    if (browserVerEl) {
      browserVerEl.textContent = info.browserVersion || info.browserVersionRaw || "—";
    }
    if (electronEl) electronEl.textContent = info.electronVersion || "—";
    if (commitRow && commitCell) {
      if (info.trackPreReleaseUpdates) {
        commitRow.hidden = false;
        const parts = [];
        if (info.localCommit) {
          parts.push(`This build: ${info.localCommit}`);
        }
        if (info.latestCommit) {
          const c = info.latestCommit;
          const line = `${c.shortSha} (${c.branch})`;
          parts.push(
            info.latestCommit.htmlUrl
              ? `<a href="${escapeHtml(c.htmlUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(line)}</a>`
              : escapeHtml(line)
          );
        } else if (info.latestCommitError) {
          parts.push(`Could not load: ${escapeHtml(info.latestCommitError)}`);
        }
        commitCell.innerHTML =
          parts.length > 0 ? parts.join("<br>") : "—";
      } else {
        commitRow.hidden = true;
        commitCell.textContent = "—";
      }
    }
  } catch (e) {
    if (appNameEl) appNameEl.textContent = "—";
    if (browserVerEl) browserVerEl.textContent = "—";
    if (electronEl) electronEl.textContent = "—";
    if (commitRow) commitRow.hidden = true;
    console.warn("get-about-browser-info:", e);
  }
}

async function runBrowserUpdateCheck({ prerelease = false } = {}) {
  const out = document.getElementById("browserUpdateResults");
  const stableBtn = document.getElementById("checkBrowserUpdatesBtn");
  const preBtn = document.getElementById("checkPrereleaseBuildsBtn");
  const btn = prerelease ? preBtn : stableBtn;
  if (!out) return;
  if (btn) btn.disabled = true;
  if (stableBtn && prerelease) stableBtn.disabled = true;
  if (preBtn && !prerelease) preBtn.disabled = true;
  out.classList.add("is-visible");
  out.textContent = prerelease
    ? "Checking GitHub for pre-release builds…"
    : "Checking GitHub for updates…";
  try {
    const result = await ipcRenderer.invoke(
      prerelease ? "check-prerelease-builds" : "check-browser-updates"
    );
    if (!result || !result.ok) {
      out.textContent =
        "Update check failed.\n" + (result && result.error ? result.error : "");
      return;
    }
    if (!result.upToDate) {
      const prompted = await ipcRenderer.invoke("show-browser-update-prompt", result);
      out.textContent = prompted.prompted
        ? prompted.action === "download"
          ? "Opened the update download page."
          : "Update available — dismissed for now."
        : result.message || "Update available.";
    } else {
      out.textContent = result.message || "Check complete.";
    }
    if (prerelease && result.channel === "commit") {
      void renderAboutBrowser();
    }
  } catch (e) {
    out.textContent =
      "Update check failed: " + (e && e.message ? e.message : String(e));
  } finally {
    if (btn) btn.disabled = false;
    if (stableBtn) stableBtn.disabled = false;
    if (preBtn) preBtn.disabled = false;
  }
}

async function renderFrameworkVersions() {
  const body = document.getElementById("frameworkVersionsBody");
  if (!body) return;
  let data = { rows: [] };
  try {
    data = await ipcRenderer.invoke("get-framework-versions");
  } catch (e) {
    console.warn("get-framework-versions:", e);
  }
  const rows = data.rows || [];
  if (!rows.length) {
    body.innerHTML =
      '<tr><td colspan="2" class="empty-hint">Could not load version information.</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map((r) => {
      const ver = r.detail ? `${escapeHtml(r.version)} (${escapeHtml(r.detail)})` : escapeHtml(r.version);
      return `<tr><td>${escapeHtml(r.name)}</td><td>${ver}</td></tr>`;
    })
    .join("");
}

async function runFrameworkUpdateCheck() {
  const out = document.getElementById("frameworkUpdateResults");
  const btn = document.getElementById("checkFrameworkUpdatesBtn");
  if (!out) return;
  if (btn) btn.disabled = true;
  out.classList.add("is-visible");
  out.textContent = "Checking npm for updates…";
  try {
    const result = await ipcRenderer.invoke("check-framework-updates");
    if (!result || !result.ok) {
      out.textContent =
        "Update check failed.\n" + (result && result.error ? result.error : "");
      return;
    }
    if (result.npmError && !result.packages.length) {
      out.textContent =
        "npm could not run (is Node.js/npm installed and on your PATH?).\n" +
        (result.npmError || "");
      return;
    }
    if (!result.packages.length) {
      out.textContent = result.includePrerelease
        ? "All tracked frameworks are up to date (including pre-release channels where checked)."
        : "All tracked frameworks are up to date.";
      return;
    }
    const lines = result.packages.map((p) => {
      const tag = p.prereleaseTag ? ` [pre-release: ${p.prereleaseTag}]` : "";
      return `${p.name}: ${p.current} → ${p.latest}${p.wanted !== p.latest ? ` (wanted ${p.wanted})` : ""}${tag}`;
    });
    out.textContent = lines.join("\n");
  } catch (e) {
    out.textContent = "Update check failed: " + (e && e.message ? e.message : String(e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

window.__bavariumRefreshDeveloper = async () => {
  await renderFrameworkVersions();
};

async function addSitePermissionOriginFromInput() {
  const input = document.getElementById("sitePermAddOrigin");
  if (!input) return;
  const raw = (input.value || "").trim();
  if (!raw) return;
  let origin = raw;
  if (!/^https?:\/\//i.test(origin)) {
    origin = "https://" + origin;
  }
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      alert("Enter a normal web address (http or https).");
      return;
    }
    origin = u.origin;
  } catch {
    alert("Enter a valid site URL, for example https://example.com");
    return;
  }
  const result = await ipcRenderer.invoke("add-site-permission-origin", { origin });
  if (!result || !result.ok) {
    alert("Could not add site.");
    return;
  }
  input.value = "";
  await renderSitePermissions();
}

async function renderDownloads() {
  const container = document.getElementById("downloadList");
  if (!container) return;
  let items = [];
  try {
    items = await ipcRenderer.invoke("get-download-records");
  } catch {
    items = [];
  }
  if (!items.length) {
    container.innerHTML =
      '<p class="empty-hint">No downloads recorded yet.</p>';
    return;
  }
  container.innerHTML = items
    .map((d) => {
      const stateLabel =
        d.state === "completed"
          ? "Completed"
          : d.state === "cancelled"
            ? "Cancelled"
            : d.state === "interrupted"
              ? "Failed"
              : String(d.state || "");
      const pathEnc = encodeURIComponent(d.path || "");
      return `
    <div class="download-row">
      <div>
        <div class="history-title">${escapeHtml(d.name || "Download")}</div>
        <div class="path-display">${escapeHtml(d.path || "")}</div>
        <div class="history-meta">${formatTime(d.ts)} · ${escapeHtml(stateLabel)}</div>
      </div>
      ${
        d.path && d.state === "completed"
          ? `<button type="button" class="btn secondary reveal-btn" data-path="${pathEnc}">Show in folder</button>`
          : ""
      }
    </div>`;
    })
    .join("");

  container.querySelectorAll(".reveal-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const enc = btn.getAttribute("data-path");
      if (enc) ipcRenderer.invoke("reveal-download", decodeURIComponent(enc));
    });
  });
}

function saveSettings() {
  void applySettingsNow({ silent: false });
}

window.addEventListener("DOMContentLoaded", async () => {
  applyVersionLabel();
  await loadSettingsFromMain();
  applySettingsToForm();
  updateLicensePortLinks();
  syncProxyFieldsVisibility();
  await refreshDownloadPathLabel();
  await renderHistory();
  await renderDownloads();

  window.__bavariumRefreshDownloads = () => renderDownloads();
  window.__bavariumRefreshHistory = () => renderHistory();

  applyHashFromLocation();
  window.addEventListener("hashchange", applyHashFromLocation);

  installAutoApplySettings();

  const uvBack = document.getElementById("licenseUvBackProxy");
  const sjBack = document.getElementById("licenseSjBackProxy");
  if (uvBack) {
    uvBack.addEventListener("click", (e) => {
      e.preventDefault();
      showSection("proxy");
    });
  }
  if (sjBack) {
    sjBack.addEventListener("click", (e) => {
      e.preventDefault();
      showSection("proxy");
    });
  }

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => showSection(btn.dataset.hash));
  });

  const proxyIconWrap = document.getElementById("proxyTypeIconSelect");
  if (proxyIconWrap) {
    wireIconSelect(proxyIconWrap, () => {
      syncProxyFieldsVisibility();
      schedulePortStatusCheck();
      scheduleApplySettings({ silent: true });
    });
    syncIconSelectFromHidden(proxyIconWrap);
  }

  const homeIconWrap = document.getElementById("homepageIconSelect");
  if (homeIconWrap) {
    wireIconSelect(homeIconWrap, () => scheduleApplySettings({ silent: true }));
    syncIconSelectFromHidden(homeIconWrap);
  }

  const searchIconWrap = document.getElementById("searchEngineIconSelect");
  if (searchIconWrap) {
    wireIconSelect(searchIconWrap, () => scheduleApplySettings({ silent: true }));
    syncIconSelectFromHidden(searchIconWrap);
  }

  document.addEventListener("click", () => {
    document.querySelectorAll("[data-icon-select].is-open").forEach((w) => {
      closeIconSelect(w);
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll("[data-icon-select].is-open").forEach((w) => {
        closeIconSelect(w);
      });
    }
  });

  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) {
    saveBtn.addEventListener("click", saveSettings);
  }

  document.getElementById("clearHistoryBtn").addEventListener("click", async () => {
    if (!confirm("Clear all browsing history?")) return;
    await ipcRenderer.invoke("clear-browsing-history");
    await renderHistory();
  });

  const sitePermAddBtn = document.getElementById("sitePermAddBtn");
  const sitePermAddOrigin = document.getElementById("sitePermAddOrigin");
  if (sitePermAddBtn) {
    sitePermAddBtn.addEventListener("click", () => {
      void addSitePermissionOriginFromInput();
    });
  }
  if (sitePermAddOrigin) {
    sitePermAddOrigin.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void addSitePermissionOriginFromInput();
      }
    });
  }

  const fpsLimitInput = document.getElementById("fpsLimit");
  if (fpsLimitInput) {
    fpsLimitInput.addEventListener("input", () => syncFpsSettingsUi());
    fpsLimitInput.addEventListener("change", () => syncFpsSettingsUi());
  }

  const checkFwBtn = document.getElementById("checkFrameworkUpdatesBtn");
  if (checkFwBtn) {
    checkFwBtn.addEventListener("click", () => {
      void runFrameworkUpdateCheck();
    });
  }

  const checkBrowserBtn = document.getElementById("checkBrowserUpdatesBtn");
  if (checkBrowserBtn) {
    checkBrowserBtn.addEventListener("click", () => {
      void runBrowserUpdateCheck({ prerelease: false });
    });
  }
  const checkPreBtn = document.getElementById("checkPrereleaseBuildsBtn");
  if (checkPreBtn) {
    checkPreBtn.addEventListener("click", () => {
      void runBrowserUpdateCheck({ prerelease: true });
    });
  }
  const trackPreReleaseEl = document.getElementById("trackPreReleaseUpdates");
  if (trackPreReleaseEl) {
    trackPreReleaseEl.addEventListener("change", () => {
      currentSettings.trackPreReleaseUpdates = !!trackPreReleaseEl.checked;
      syncAboutPrereleaseUi();
      if (document.getElementById("section-about")?.classList.contains("active")) {
        void renderAboutBrowser();
      }
    });
  }

  const clearAllSitePermBtn = document.getElementById("clearAllSitePermissionsBtn");
  if (clearAllSitePermBtn) {
    clearAllSitePermBtn.addEventListener("click", async () => {
      if (!confirm("Reset all site permission rules? Sites will ask again when they need access.")) {
        return;
      }
      await ipcRenderer.invoke("clear-all-site-permissions");
      await renderSitePermissions();
    });
  }

  const clearAllBtn = document.getElementById("clearAllBrowserDataBtn");
  if (clearAllBtn) {
    clearAllBtn.addEventListener("click", async () => {
      if (
        !confirm(
          "Delete all browser data and logs?\n\n" +
            "This clears browsing history, download history, site permission rules, bookmarks, and all site data " +
            "(cookies, storage, cache). Settings you see here stay saved. Open tabs will reload."
        )
      ) {
        return;
      }
      try {
        await ipcRenderer.invoke("bavarium-clear-all-browser-data");
        await renderHistory();
        await renderSitePermissions();
        await renderDownloads();
      } catch (e) {
        alert("Could not clear all data: " + (e && e.message ? e.message : String(e)));
      }
    });
  }

  document.getElementById("chooseDownloadFolderBtn").addEventListener(
    "click",
    async () => {
      const picked = await ipcRenderer.invoke("select-download-folder");
      if (!picked) return;
      currentSettings.downloadPath = picked;
      await refreshDownloadPathLabel();
      await applySettingsNow({ silent: true });
    }
  );

  document.getElementById("resetDownloadFolderBtn").addEventListener(
    "click",
    async () => {
      delete currentSettings.downloadPath;
      currentSettings.downloadPath = "";
      await refreshDownloadPathLabel();
      await applySettingsNow({ silent: true });
    }
  );

  document.getElementById("clearDownloadHistoryBtn").addEventListener(
    "click",
    async () => {
      if (!confirm("Clear the download history list?")) return;
      await ipcRenderer.invoke("clear-download-records");
      await renderDownloads();
    }
  );

  ipcRenderer.on("downloads-updated", () => {
    void renderDownloads();
  });

  async function syncSettingsFormFromMain(payload) {
    if (payload && typeof payload === "object") {
      currentSettings = payload;
    } else {
      await loadSettingsFromMain();
    }
    applySettingsToForm();
    schedulePortStatusCheck();
    updateLicensePortLinks();
  }

  ipcRenderer.on("settings-updated", (_e, payload) => {
    void syncSettingsFormFromMain(payload);
    syncAboutPrereleaseUi();
    if (document.getElementById("section-about")?.classList.contains("active")) {
      void renderAboutBrowser();
    }
    if (document.getElementById("section-developer")?.classList.contains("active")) {
      void renderFrameworkVersions();
    }
  });

  ipcRenderer.on("proxy-port-state", (_e, state) => {
    if (!state || typeof state !== "object") return;
    if (state.settings && typeof state.settings === "object") {
      currentSettings = state.settings;
      applySettingsToForm();
      schedulePortStatusCheck();
      updateLicensePortLinks();
    }
    if (state.status === "failed") {
      setSaveStatus(
        state.message ||
          `Proxy failed on port ${state.port ?? "?"}. Pick another port below.`
      );
      setPortStatusLine(
        document.getElementById(
          state.proxyType === "scramjet" ? "scramjetPortStatus" : "uvPortStatus"
        ),
        state.message || `Port ${state.port} failed — try the next available port.`,
        "bad"
      );
    } else if (state.status === "relocated") {
      setSaveStatus(
        state.message || `Proxy is using port ${state.port} (port field updated).`
      );
      schedulePortStatusCheck();
    } else if (state.status === "running") {
      schedulePortStatusCheck();
    }
  });

  settingsFormReady = true;
});
