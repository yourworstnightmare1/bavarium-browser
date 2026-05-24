"use strict";

const { ipcRenderer } = require("electron");

const GITHUB_REPO = "https://github.com/yourworstnightmare1/bavarium-browser";
const DEFAULT_FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#9aa0a6"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
  );

const SITE_SLOTS = 9;
let searchEngine = "google";
let suggestTimer = null;
let suggestIndex = -1;
let suggestItems = [];
let editingFavoriteId = null;
let favorites = [];

const searchInput = document.getElementById("searchInput");
const suggestList = document.getElementById("suggestList");
const tileGrid = document.getElementById("tileGrid");
const favoriteModal = document.getElementById("favoriteModal");
const favoriteTitle = document.getElementById("favoriteTitle");
const favoriteUrl = document.getElementById("favoriteUrl");
const favoriteRemove = document.getElementById("favoriteRemove");
const favoriteSave = document.getElementById("favoriteSave");
const favoriteCancel = document.getElementById("favoriteCancel");
const favoriteModalTitle = document.getElementById("favoriteModalTitle");
const footerVersion = document.getElementById("footerVersion");
const footerGithub = document.getElementById("footerGithub");

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeMatchUrl(url) {
  if (!url || typeof url !== "string") return "";
  const t = url.trim();
  if (!t) return "";
  try {
    const u = new URL(t.startsWith("http") ? t : "https://" + t);
    let href = u.href;
    if (href.length > 1 && href.endsWith("/")) href = href.slice(0, -1);
    return href;
  } catch {
    return t;
  }
}

function faviconForUrl(url) {
  if (!url || typeof url !== "string") return DEFAULT_FAVICON;
  if (url.trim().startsWith("bavarium://")) return DEFAULT_FAVICON;
  try {
    const u = new URL(url.startsWith("http") ? url : "https://" + url);
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(u.hostname)}&sz=64`;
  } catch {
    return DEFAULT_FAVICON;
  }
}

function labelForSite(entry) {
  if (entry.displayTitle && String(entry.displayTitle).trim()) {
    return String(entry.displayTitle).trim();
  }
  if (entry.title && String(entry.title).trim()) return String(entry.title).trim();
  try {
    return new URL(entry.url).hostname.replace(/^www\./i, "");
  } catch {
    return entry.url || "Site";
  }
}

async function normalizeTileEntry(entry) {
  if (!entry || !entry.url) return null;
  try {
    const meta = await ipcRenderer.invoke("normalize-site-tile-meta", {
      url: entry.url,
      title: entry.title || "",
    });
    if (!meta || !meta.isRemote) return null;
    return {
      ...entry,
      url: meta.url,
      title: meta.title,
      displayTitle: meta.title,
      faviconUrl: entry.faviconUrl || faviconForUrl(meta.url),
    };
  } catch (_) {
    return null;
  }
}

function navigate(raw) {
  const text = String(raw || "").trim();
  if (!text) return;
  ipcRenderer.sendToHost("bavarium-newtab-navigate", text);
}

async function loadSettings() {
  try {
    const s = await ipcRenderer.invoke("get-settings");
    if (s && s.searchEngine) searchEngine = s.searchEngine;
  } catch (_) {}
}

function formatFooterStatusLine(info) {
  if (!info || typeof info !== "object") {
    return "Bavarium Browser | Service Inactive";
  }
  const name = info.appName || "Bavarium Browser";
  const version = info.version ? ` ${info.version}` : "";
  const platform = info.platform ? ` ${info.platform}` : "";
  const proxy = info.proxyLabel || "Service Inactive";
  return `${name}${version}${platform} | ${proxy}`;
}

async function loadFooterStatus() {
  footerGithub.href = GITHUB_REPO;
  try {
    const info = await ipcRenderer.invoke("get-newtab-footer-info");
    footerVersion.textContent = formatFooterStatusLine(info);
  } catch {
    footerVersion.textContent = "Bavarium Browser | Service Inactive";
  }
}

let footerStatusPollTimer = null;

function startFooterStatusPoll() {
  if (footerStatusPollTimer) return;
  footerStatusPollTimer = setInterval(() => {
    void loadFooterStatus();
  }, 2500);
}

async function loadFavorites() {
  try {
    const list = await ipcRenderer.invoke("get-homepage-favorites");
    const raw = Array.isArray(list) ? list.filter((f) => f && f.url) : [];
    const normalized = [];
    let changed = false;
    for (const f of raw) {
      const row = await normalizeTileEntry(f);
      if (!row) continue;
      if (
        row.url !== f.url ||
        row.title !== (f.title || "") ||
        row.faviconUrl !== (f.faviconUrl || "")
      ) {
        changed = true;
      }
      normalized.push({
        ...f,
        url: row.url,
        title: row.title,
        faviconUrl: row.faviconUrl,
      });
    }
    favorites = normalized;
    if (changed) {
      await saveFavorites();
    }
  } catch {
    favorites = [];
  }
  if (favorites.length > SITE_SLOTS) {
    favorites = favorites.slice(0, SITE_SLOTS);
  }
}

async function saveFavorites() {
  await ipcRenderer.invoke("save-homepage-favorites", favorites);
}

async function loadRecentSites() {
  let items = [];
  try {
    items = await ipcRenderer.invoke("get-browsing-history");
  } catch {
    items = [];
  }
  const out = [];
  const seen = new Set(
    favorites.map((f) => normalizeMatchUrl(f.url)).filter(Boolean)
  );
  for (const h of items) {
    if (!h || !h.url) continue;
    const row = await normalizeTileEntry({
      url: h.url,
      title: h.title || "",
    });
    if (!row) continue;
    const u = row.url;
    if (!u || u.startsWith("bavarium://") || u.includes("settings.html")) continue;
    if (u.includes("newtab.html")) continue;
    const key = normalizeMatchUrl(u);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: "recent-" + key,
      url: u,
      title: row.title,
      displayTitle: row.title,
      faviconUrl: row.faviconUrl,
      favorite: false,
    });
    if (out.length >= SITE_SLOTS) break;
  }
  return out;
}

async function buildTileEntries() {
  const entries = favorites.map((f) => ({
    ...f,
    favorite: true,
    faviconUrl: f.faviconUrl || faviconForUrl(f.url),
  }));
  const recents = await loadRecentSites();
  for (const r of recents) {
    if (entries.length >= SITE_SLOTS) break;
    entries.push(r);
  }
  return entries;
}

function renderTiles(entries) {
  tileGrid.innerHTML = "";
  for (let i = 0; i < 10; i++) {
    if (i === 9) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "tile add";
      add.title = "Add favorite";
      add.innerHTML =
        '<span class="tile-icon" aria-hidden="true">' +
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg></span>' +
        '<span class="tile-label">Add favorite</span>';
      add.addEventListener("click", () => openFavoriteModal(null));
      tileGrid.appendChild(add);
      continue;
    }
    const entry = entries[i];
    if (!entry) {
      const empty = document.createElement("div");
      empty.className = "tile empty";
      empty.setAttribute("aria-hidden", "true");
      tileGrid.appendChild(empty);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tile site" + (entry.favorite ? " is-favorite" : "");
    const label = labelForSite(entry);
    btn.title = entry.url;
    btn.innerHTML =
      `<img class="tile-icon" src="${escapeHtml(entry.faviconUrl || faviconForUrl(entry.url))}" alt="" width="40" height="40" decoding="async" />` +
      `<span class="tile-label">${escapeHtml(label)}</span>`;
    const img = btn.querySelector(".tile-icon");
    img.addEventListener("error", () => {
      img.src = DEFAULT_FAVICON;
      img.onerror = null;
    });
    btn.addEventListener("click", () => navigate(entry.url));
    if (entry.favorite) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "tile-fav-badge";
      edit.title = "Edit favorite";
      edit.textContent = "✎";
      edit.addEventListener("click", (e) => {
        e.stopPropagation();
        openFavoriteModal(entry.id);
      });
      btn.appendChild(edit);
    }
    tileGrid.appendChild(btn);
  }
}

async function refreshTiles() {
  await loadFavorites();
  const entries = await buildTileEntries();
  renderTiles(entries);
}

function hideSuggestions() {
  suggestList.classList.remove("open");
  suggestList.innerHTML = "";
  suggestIndex = -1;
  suggestItems = [];
}

function renderSuggestions(items) {
  suggestItems = items;
  suggestIndex = -1;
  if (!items.length) {
    hideSuggestions();
    return;
  }
  suggestList.innerHTML = items
    .map(
      (text, i) =>
        `<li role="option" data-index="${i}">${escapeHtml(text)}</li>`
    )
    .join("");
  suggestList.classList.add("open");
  suggestList.querySelectorAll("li").forEach((li) => {
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const idx = parseInt(li.dataset.index, 10);
      if (Number.isFinite(idx) && suggestItems[idx]) {
        searchInput.value = suggestItems[idx];
        hideSuggestions();
        navigate(suggestItems[idx]);
      }
    });
  });
}

function highlightSuggestion() {
  suggestList.querySelectorAll("li").forEach((li, i) => {
    li.classList.toggle("active", i === suggestIndex);
  });
  if (suggestIndex >= 0 && suggestItems[suggestIndex]) {
    searchInput.value = suggestItems[suggestIndex];
  }
}

async function fetchSuggestions(query) {
  if (!query.trim()) {
    hideSuggestions();
    return;
  }
  try {
    const items = await ipcRenderer.invoke("bavarium-search-suggest", {
      query: query.trim(),
      searchEngine,
    });
    renderSuggestions(Array.isArray(items) ? items : []);
  } catch {
    hideSuggestions();
  }
}

function scheduleSuggestions() {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(() => {
    void fetchSuggestions(searchInput.value);
  }, 120);
}

function newFavoriteId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function openFavoriteModal(id) {
  editingFavoriteId = id || null;
  if (id) {
    const fav = favorites.find((f) => f.id === id);
    if (!fav) return;
    favoriteTitle.value = fav.title || "";
    favoriteUrl.value = fav.url || "";
    favoriteModalTitle.textContent = "Edit favorite";
    favoriteRemove.style.display = "";
  } else {
    favoriteTitle.value = "";
    favoriteUrl.value = searchInput.value.trim() || "";
    favoriteModalTitle.textContent = "Add favorite";
    favoriteRemove.style.display = "none";
  }
  favoriteModal.classList.add("open");
  favoriteTitle.focus();
  favoriteTitle.select();
}

function closeFavoriteModal() {
  favoriteModal.classList.remove("open");
  editingFavoriteId = null;
}

async function saveFavoriteFromModal() {
  let title = favoriteTitle.value.trim() || "Favorite";
  let url = favoriteUrl.value.trim();
  if (!url) {
    alert("URL is required.");
    return;
  }
  try {
    const meta = await ipcRenderer.invoke("normalize-site-tile-meta", {
      url,
      title,
    });
    if (meta && meta.isRemote) {
      url = meta.url;
      title = meta.title || title;
    }
  } catch (_) {}
  const faviconUrl = faviconForUrl(url);
  if (editingFavoriteId) {
    const i = favorites.findIndex((f) => f.id === editingFavoriteId);
    if (i !== -1) {
      favorites[i] = { ...favorites[i], title, url, faviconUrl };
    }
  } else {
    if (favorites.length >= SITE_SLOTS) {
      alert("Maximum " + SITE_SLOTS + " favorites. Remove one to add another.");
      return;
    }
    favorites.push({
      id: newFavoriteId(),
      title,
      url,
      faviconUrl,
    });
  }
  await saveFavorites();
  closeFavoriteModal();
  await refreshTiles();
}

async function removeFavoriteFromModal() {
  if (!editingFavoriteId) return;
  favorites = favorites.filter((f) => f.id !== editingFavoriteId);
  await saveFavorites();
  closeFavoriteModal();
  await refreshTiles();
}

searchInput.addEventListener("input", scheduleSuggestions);
searchInput.addEventListener("focus", scheduleSuggestions);
searchInput.addEventListener("blur", () => {
  setTimeout(hideSuggestions, 150);
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideSuggestions();
    return;
  }
  if (!suggestList.classList.contains("open") || !suggestItems.length) {
    if (e.key === "Enter") {
      e.preventDefault();
      hideSuggestions();
      navigate(searchInput.value);
    }
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    suggestIndex = Math.min(suggestItems.length - 1, suggestIndex + 1);
    highlightSuggestion();
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    suggestIndex = Math.max(0, suggestIndex - 1);
    highlightSuggestion();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const q =
      suggestIndex >= 0 && suggestItems[suggestIndex]
        ? suggestItems[suggestIndex]
        : searchInput.value;
    hideSuggestions();
    navigate(q);
  }
});

favoriteSave.addEventListener("click", () => void saveFavoriteFromModal());
favoriteCancel.addEventListener("click", closeFavoriteModal);
favoriteRemove.addEventListener("click", () => void removeFavoriteFromModal());
favoriteModal.addEventListener("click", (e) => {
  if (e.target === favoriteModal) closeFavoriteModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && favoriteModal.classList.contains("open")) {
    closeFavoriteModal();
  }
});

ipcRenderer.on("settings-updated", () => {
  void loadSettings();
  void loadFooterStatus();
});

ipcRenderer.on("proxy-port-state", () => {
  void loadFooterStatus();
});

ipcRenderer.on("browser-data-cleared", () => {
  void refreshTiles();
});

void (async () => {
  await loadSettings();
  await loadFooterStatus();
  startFooterStatusPoll();
  await refreshTiles();
  searchInput.focus();
})();
