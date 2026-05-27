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
let newtabSettings = {
  homepageShowTiles: true,
  homepageShowVersionInfo: true,
  homepageShowSystemInfo: true,
  homepageShowProxyPort: true,
  homepageCustomBackgroundUrl: "",
  homepageTimeFormat: "12",
  homepageShowClock: true,
  homepageShowWeather: true,
  homepageWeatherCity: "",
};

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
const homepageClock = document.getElementById("homepageClock");
const homepageClockDate = document.getElementById("homepageClockDate");
const homepageClockTime = document.getElementById("homepageClockTime");
const homepageWeather = document.getElementById("homepageWeather");
const homepageWeatherIcon = document.getElementById("homepageWeatherIcon");
const homepageWeatherTemp = document.getElementById("homepageWeatherTemp");
const homepageWeatherLabel = document.getElementById("homepageWeatherLabel");

let homepageClockTimer = null;
let homepageWeatherTimer = null;
const WEATHER_COORDS_CACHE_KEY = "bavarium-homepage-weather-coords";
const WEATHER_COORDS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function normalizeHomepageTimeFormat(raw) {
  return raw === "24" ? "24" : "12";
}

function formatHomepageDateLine(now) {
  const dayName = now.toLocaleDateString(undefined, { weekday: "long" });
  const monthName = now.toLocaleDateString(undefined, { month: "long" });
  return `${dayName}, ${monthName} ${now.getDate()}`;
}

function formatHomepageTimeLine(now, timeFormat) {
  const hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  if (normalizeHomepageTimeFormat(timeFormat) === "24") {
    const h24 = String(hours).padStart(2, "0");
    return `${h24}:${minutes}:${seconds}`;
  }
  const h12 = hours % 12 || 12;
  const ampm = hours < 12 ? "AM" : "PM";
  return `${h12}:${minutes}:${seconds} ${ampm}`;
}

function setHomepageClockVisible(show) {
  if (!homepageClock) return;
  homepageClock.classList.toggle("homepage-clock-hidden", !show);
}

function updateHomepageClock() {
  if (newtabSettings.homepageShowClock === false) {
    setHomepageClockVisible(false);
    return;
  }
  if (!homepageClockDate || !homepageClockTime) return;
  const now = new Date();
  homepageClockDate.textContent = formatHomepageDateLine(now);
  homepageClockTime.textContent = formatHomepageTimeLine(
    now,
    newtabSettings.homepageTimeFormat
  );
  setHomepageClockVisible(true);
}

function startHomepageClock() {
  updateHomepageClock();
  if (homepageClockTimer) clearInterval(homepageClockTimer);
  homepageClockTimer = setInterval(updateHomepageClock, 1000);
}

function weatherLabelFromCode(code) {
  const map = {
    0: "Clear",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Fog",
    51: "Light drizzle",
    53: "Drizzle",
    55: "Dense drizzle",
    56: "Freezing drizzle",
    57: "Freezing drizzle",
    61: "Light rain",
    63: "Rain",
    65: "Heavy rain",
    66: "Freezing rain",
    67: "Freezing rain",
    71: "Light snow",
    73: "Snow",
    75: "Heavy snow",
    77: "Snow grains",
    80: "Rain showers",
    81: "Rain showers",
    82: "Heavy showers",
    85: "Snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with hail",
    99: "Thunderstorm with hail",
  };
  return map[code] || "Unknown";
}

function weatherKindFromCode(code, isDay) {
  if (code === 0) return isDay ? "clear" : "clear-night";
  if (code === 1) return isDay ? "mainly-clear" : "clear-night";
  if (code === 2) return "partly-cloudy";
  if (code === 3) return "overcast";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "rain";
  if (code >= 85 && code <= 86) return "snow";
  if (code >= 95) return "thunder";
  return "overcast";
}

function weatherIconMarkup(kind) {
  switch (kind) {
    case "clear":
      return '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>';
    case "clear-night":
      return '<path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 6.5 6.5 0 0 0 21 14.5z" fill="currentColor" stroke="none"/>';
    case "mainly-clear":
      return '<circle cx="7" cy="7" r="3" fill="currentColor" stroke="none"/><path d="M7 2v1M7 11v1M3 7h1M10 7h1M4.2 4.2l.7.7M8.8 8.8l.7.7M4.2 9.8l.7-.7M8.8 5.2l.7-.7"/><path d="M8 17a6 6 0 1 1 11-2.5"/>';
    case "partly-cloudy":
      return '<circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/><path d="M8 4v1M8 12v1M5 8h1M11 8h1M6.2 6.2l.7.7M9.8 9.8l.7.7M6.2 9.8l.7-.7M9.8 6.2l.7-.7"/><path d="M7 18a5 5 0 1 1 9.5-1.8"/>';
    case "overcast":
      return '<path d="M7 18a5 5 0 1 1 9.5-1.8"/><path d="M17 16a4 4 0 1 0-7.8-1.2"/>';
    case "fog":
      return '<path d="M4 14h16M6 18h12M8 10h8"/>';
    case "drizzle":
    case "rain":
      return '<path d="M7 15a5 5 0 1 1 9.5-1.8"/><path d="M8 19v2M12 19v2M16 19v2"/>';
    case "snow":
      return '<path d="M7 14a5 5 0 1 1 9.5-1.8"/><path d="M8 19l1-1 1 1-1 1-1-1M12 19l1-1 1 1-1 1-1-1M16 19l1-1 1 1-1 1-1-1"/>';
    case "thunder":
      return '<path d="M7 14a5 5 0 1 1 9.5-1.8"/><path d="M13 16l-3 5h4l-2 3" fill="currentColor" stroke="none"/>';
    default:
      return '<path d="M7 15a5 5 0 1 1 9.5-1.8"/>';
  }
}

function readCachedWeatherCoords() {
  try {
    const raw = localStorage.getItem(WEATHER_COORDS_CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (
      !data ||
      typeof data.lat !== "number" ||
      typeof data.lon !== "number" ||
      !data.savedAt
    ) {
      return null;
    }
    if (Date.now() - data.savedAt > WEATHER_COORDS_MAX_AGE_MS) return null;
    const wantedCity = String(newtabSettings.homepageWeatherCity || "").trim();
    if (data.city && data.city !== wantedCity) return null;
    if (wantedCity && !data.city) return null;
    return { lat: data.lat, lon: data.lon };
  } catch (_) {
    return null;
  }
}

function saveCachedWeatherCoords(lat, lon, city) {
  try {
    localStorage.setItem(
      WEATHER_COORDS_CACHE_KEY,
      JSON.stringify({
        lat,
        lon,
        savedAt: Date.now(),
        city: String(city || "").trim(),
      })
    );
  } catch (_) {}
}

function getCoordsFromBrowser() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation unavailable"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
        }),
      (err) => reject(err || new Error("Geolocation denied")),
      {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 10 * 60 * 1000,
      }
    );
  });
}

async function geocodeWeatherCity(city) {
  const name = String(city || "").trim();
  if (!name) return null;
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", name);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Geocoding HTTP ${res.status}`);
  const data = await res.json();
  const hit = data && data.results && data.results[0];
  if (!hit || hit.latitude == null || hit.longitude == null) return null;
  return { lat: hit.latitude, lon: hit.longitude };
}

async function resolveWeatherCoords() {
  const cached = readCachedWeatherCoords();
  if (cached) return cached;

  try {
    const coords = await getCoordsFromBrowser();
    saveCachedWeatherCoords(coords.lat, coords.lon, "");
    return coords;
  } catch (_) {}

  try {
    const coords = await ipcRenderer.invoke("get-homepage-weather-coords");
    if (coords && typeof coords.lat === "number" && typeof coords.lon === "number") {
      saveCachedWeatherCoords(coords.lat, coords.lon, "");
      return { lat: coords.lat, lon: coords.lon };
    }
  } catch (_) {}

  const city = String(newtabSettings.homepageWeatherCity || "").trim();
  if (city) {
    const coords = await geocodeWeatherCity(city);
    if (coords) {
      saveCachedWeatherCoords(coords.lat, coords.lon, city);
      return coords;
    }
  }

  return null;
}

function weatherUsesFahrenheit() {
  try {
    const loc =
      Intl.DateTimeFormat().resolvedOptions().locale ||
      navigator.language ||
      "en-US";
    return /^en(-|$)/i.test(loc);
  } catch (_) {
    return true;
  }
}

async function fetchCurrentWeather(lat, lon) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,weather_code,is_day");
  url.searchParams.set(
    "temperature_unit",
    weatherUsesFahrenheit() ? "fahrenheit" : "celsius"
  );
  url.searchParams.set("timezone", "auto");
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Weather HTTP ${res.status}`);
  const data = await res.json();
  return data && data.current ? data.current : null;
}

function setHomepageWeatherVisible(show) {
  if (!homepageWeather) return;
  homepageWeather.classList.toggle("homepage-weather-hidden", !show);
}

function renderHomepageWeather(current) {
  if (
    !homepageWeather ||
    !homepageWeatherIcon ||
    !homepageWeatherTemp ||
    !homepageWeatherLabel ||
    !current
  ) {
    setHomepageWeatherVisible(false);
    return;
  }
  const code = Number(current.weather_code);
  const isDay = Number(current.is_day) === 1;
  const kind = weatherKindFromCode(code, isDay);
  const unit = weatherUsesFahrenheit() ? "°F" : "°C";
  homepageWeatherIcon.innerHTML = weatherIconMarkup(kind);
  homepageWeatherTemp.textContent = `${Math.round(current.temperature_2m)}${unit}`;
  homepageWeatherLabel.textContent = weatherLabelFromCode(code);
  setHomepageWeatherVisible(true);
}

async function updateHomepageWeather() {
  if (newtabSettings.homepageShowWeather === false) {
    setHomepageWeatherVisible(false);
    return;
  }
  try {
    const coords = await resolveWeatherCoords();
    if (!coords) {
      setHomepageWeatherVisible(false);
      return;
    }
    const current = await fetchCurrentWeather(coords.lat, coords.lon);
    renderHomepageWeather(current);
  } catch (_) {
    setHomepageWeatherVisible(false);
  }
}

function startHomepageWeather() {
  void updateHomepageWeather();
  if (homepageWeatherTimer) clearInterval(homepageWeatherTimer);
  homepageWeatherTimer = setInterval(() => {
    void updateHomepageWeather();
  }, 15 * 60 * 1000);
}

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
    newtabSettings.homepageShowTiles = s.homepageShowTiles !== false;
    newtabSettings.homepageShowVersionInfo = s.homepageShowVersionInfo !== false;
    newtabSettings.homepageShowSystemInfo = s.homepageShowSystemInfo !== false;
    newtabSettings.homepageShowProxyPort = s.homepageShowProxyPort !== false;
    newtabSettings.homepageTimeFormat = normalizeHomepageTimeFormat(
      s.homepageTimeFormat
    );
    newtabSettings.homepageShowClock = s.homepageShowClock !== false;
    newtabSettings.homepageShowWeather = s.homepageShowWeather !== false;
    newtabSettings.homepageWeatherCity = String(s.homepageWeatherCity || "").trim();
  } catch (_) {}
  try {
    const bg = await ipcRenderer.invoke("get-homepage-background-url");
    newtabSettings.homepageCustomBackgroundUrl =
      typeof bg === "string" ? bg : "";
  } catch (_) {
    newtabSettings.homepageCustomBackgroundUrl = "";
  }
}

function applyNewtabAppearance() {
  const showTiles = newtabSettings.homepageShowTiles !== false;
  if (tileGrid) {
    tileGrid.classList.toggle("tiles-hidden", !showTiles);
  }
  const bgUrl = newtabSettings.homepageCustomBackgroundUrl || "";
  if (bgUrl) {
    document.body.classList.add("has-custom-bg");
    document.body.style.backgroundImage = `url("${bgUrl.replace(/"/g, '\\"')}")`;
  } else {
    document.body.classList.remove("has-custom-bg");
    document.body.style.backgroundImage = "";
  }
}

function formatFooterStatusLine(info) {
  if (!info || typeof info !== "object") {
    return "Bavarium Browser | Service Inactive";
  }
  const showVersion =
    info.showVersionInfo !== false &&
    newtabSettings.homepageShowVersionInfo !== false;
  const showSystem =
    info.showSystemInfo !== false &&
    newtabSettings.homepageShowSystemInfo !== false;
  const showProxy =
    info.showProxyPort !== false && newtabSettings.homepageShowProxyPort !== false;

  const left = [];
  if (showVersion) {
    const name = info.appName || "Bavarium Browser";
    const version = info.version ? ` ${info.version}` : "";
    left.push(`${name}${version}`.trim());
  }
  if (showSystem && info.platform) {
    left.push(info.platform);
  }
  const leftStr = left.join(" ").trim();
  const proxy = info.proxyLabel || "Service Inactive";
  let text = "";
  if (showProxy && leftStr) text = `${leftStr} | ${proxy}`;
  else if (showProxy) text = proxy;
  else text = leftStr;
  return text || "";
}

function openExternalUrl(url) {
  ipcRenderer.sendToHost("bavarium-open-external-url", url);
}

footerGithub.addEventListener("click", (e) => {
  e.preventDefault();
  openExternalUrl(GITHUB_REPO);
});

async function loadFooterStatus() {
  footerGithub.href = GITHUB_REPO;
  const footer = document.querySelector(".footer");
  try {
    const info = await ipcRenderer.invoke("get-newtab-footer-info");
    if (info && typeof info === "object") {
      if (info.homepageShowTiles !== undefined) {
        newtabSettings.homepageShowTiles = info.homepageShowTiles !== false;
      }
      if (info.homepageCustomBackgroundUrl) {
        newtabSettings.homepageCustomBackgroundUrl = info.homepageCustomBackgroundUrl;
      }
      if (info.showVersionInfo !== undefined) {
        newtabSettings.homepageShowVersionInfo = info.showVersionInfo !== false;
      }
      if (info.showSystemInfo !== undefined) {
        newtabSettings.homepageShowSystemInfo = info.showSystemInfo !== false;
      }
      if (info.showProxyPort !== undefined) {
        newtabSettings.homepageShowProxyPort = info.showProxyPort !== false;
      }
      if (info.homepageTimeFormat !== undefined) {
        newtabSettings.homepageTimeFormat = normalizeHomepageTimeFormat(
          info.homepageTimeFormat
        );
      }
      if (info.homepageShowClock !== undefined) {
        newtabSettings.homepageShowClock = info.homepageShowClock !== false;
      }
      if (info.homepageShowWeather !== undefined) {
        newtabSettings.homepageShowWeather = info.homepageShowWeather !== false;
      }
    }
    applyNewtabAppearance();
    updateHomepageClock();
    void updateHomepageWeather();
    const line = formatFooterStatusLine(info);
    footerVersion.textContent = line;
    if (footer) footer.classList.toggle("footer-hidden", !line);
  } catch {
    footerVersion.textContent = "Bavarium Browser | Service Inactive";
    if (footer) footer.classList.remove("footer-hidden");
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
  if (newtabSettings.homepageShowTiles === false) {
    if (tileGrid) tileGrid.innerHTML = "";
    return;
  }
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
  void refreshNewtabFromSettings();
});

async function refreshNewtabFromSettings() {
  await loadSettings();
  applyNewtabAppearance();
  updateHomepageClock();
  void updateHomepageWeather();
  await loadFooterStatus();
  await refreshTiles();
}

window.__bavariumRefreshNewtab = refreshNewtabFromSettings;

ipcRenderer.on("proxy-port-state", () => {
  void loadFooterStatus();
});

ipcRenderer.on("browser-data-cleared", () => {
  void refreshTiles();
});

void (async () => {
  await loadSettings();
  applyNewtabAppearance();
  startHomepageClock();
  startHomepageWeather();
  await loadFooterStatus();
  startFooterStatusPoll();
  await refreshTiles();
  searchInput.focus();
})();
