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
    el.textContent = "v1.0b";
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

/** URL hash fragment → sidebar section id (DOM: section-{id}) */
const HASH_TO_NAV = {
  settings: "proxy",
  proxy: "proxy",
  browsing: "browsing",
  history: "privacy",
  privacy: "privacy",
  downloads: "downloads",
};

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
    setPortStatusLine(
      el,
      "Port is already in use — choose another port or stop the other program.",
      "bad"
    );
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
  if (homeH) homeH.value = s.homepage || "google";
  syncIconSelectFromHidden(document.getElementById("homepageIconSelect"));
  const seH = document.getElementById("searchEngine");
  if (seH) seH.value = s.searchEngine || "google";
  syncIconSelectFromHidden(document.getElementById("searchEngineIconSelect"));
  document.getElementById("historyEnabled").checked = s.historyEnabled !== false;
  document.getElementById("askBeforeDownload").checked =
    s.askBeforeDownload !== false;
  syncProxyFieldsVisibility();
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
    homepage: document.getElementById("homepage").value.trim() || "google",
    historyEnabled: document.getElementById("historyEnabled").checked,
    askBeforeDownload: document.getElementById("askBeforeDownload").checked,
    downloadPath: currentSettings.downloadPath || "",
  };
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
  alert("Settings saved.");
  schedulePortStatusCheck();
  updateLicensePortLinks();
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

  ["uvPort", "scramjetPort"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("input", () => {
        schedulePortStatusCheck();
        updateLicensePortLinks();
      });
      el.addEventListener("change", () => {
        schedulePortStatusCheck();
        updateLicensePortLinks();
      });
    }
  });
  const proxyIconWrap = document.getElementById("proxyTypeIconSelect");
  if (proxyIconWrap) {
    wireIconSelect(proxyIconWrap, () => {
      syncProxyFieldsVisibility();
      schedulePortStatusCheck();
    });
    syncIconSelectFromHidden(proxyIconWrap);
  }

  const homeIconWrap = document.getElementById("homepageIconSelect");
  if (homeIconWrap) {
    wireIconSelect(homeIconWrap, () => {});
    syncIconSelectFromHidden(homeIconWrap);
  }

  const searchIconWrap = document.getElementById("searchEngineIconSelect");
  if (searchIconWrap) {
    wireIconSelect(searchIconWrap, () => {});
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

  document.getElementById("saveBtn").addEventListener("click", saveSettings);

  document.getElementById("clearHistoryBtn").addEventListener("click", async () => {
    if (!confirm("Clear all browsing history?")) return;
    await ipcRenderer.invoke("clear-browsing-history");
    await renderHistory();
  });

  const clearAllBtn = document.getElementById("clearAllBrowserDataBtn");
  if (clearAllBtn) {
    clearAllBtn.addEventListener("click", async () => {
      if (
        !confirm(
          "Delete all browser data and logs?\n\n" +
            "This clears browsing history, download history, bookmarks, and all site data " +
            "(cookies, storage, cache). Settings you see here stay saved. Open tabs will reload."
        )
      ) {
        return;
      }
      try {
        await ipcRenderer.invoke("bavarium-clear-all-browser-data");
        await renderHistory();
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
      ipcRenderer.send("save-settings", collectSettingsFromForm());
    }
  );

  document.getElementById("resetDownloadFolderBtn").addEventListener(
    "click",
    async () => {
      delete currentSettings.downloadPath;
      currentSettings.downloadPath = "";
      await refreshDownloadPathLabel();
      ipcRenderer.send("save-settings", collectSettingsFromForm());
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

});
