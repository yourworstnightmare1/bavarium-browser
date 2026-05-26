'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { checkGoogleSafeBrowsingUrl } = require('./google-safe-browsing');

/** CERT Polska Warning List — https://cert.pl/en/warning-list/ */
const CERT_PL_LIST_URL = 'https://hole.cert.pl/domains/v2/domains.txt';

const PHISHING_DB_LIST_URL =
  'https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-domains-ACTIVE.txt';

const DEFAULT_LIST_URLS = [CERT_PL_LIST_URL, PHISHING_DB_LIST_URL];

const REFRESH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function fetchText(url, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent': 'Bavarium-Browser-SafeBrowsing/1.0',
          Accept: 'text/plain,*/*',
        },
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          fetchText(res.headers.location, timeoutMs).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve(body));
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

function normalizeHostname(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let h = raw.trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('www.')) h = h.slice(4);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

function hostnameFromUrl(url) {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return normalizeHostname(u.hostname);
  } catch {
    return '';
  }
}

/** Parse hosts-file lines, plain domains, or full URLs (one per line). */
function parseBlocklistText(text) {
  const hosts = new Set();
  if (!text || typeof text !== 'string') return hosts;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    let token = trimmed;
    if (token.includes(' ')) {
      const parts = token.split(/\s+/).filter(Boolean);
      token = parts[parts.length - 1];
    }
    if (/^https?:\/\//i.test(token)) {
      const fromUrl = hostnameFromUrl(token);
      if (fromUrl) hosts.add(fromUrl);
      continue;
    }
    const host = normalizeHostname(token.replace(/^\.+/, ''));
    if (host && host.includes('.')) hosts.add(host);
  }
  return hosts;
}

function isHostBlocked(hostname, blockedHosts) {
  const h = normalizeHostname(hostname);
  if (!h || !blockedHosts || blockedHosts.size === 0) return false;
  if (blockedHosts.has(h)) return true;
  const parts = h.split('.');
  for (let i = 1; i < parts.length; i++) {
    const suffix = parts.slice(i).join('.');
    if (blockedHosts.has(suffix)) return true;
  }
  return false;
}

function normalizeProviderMode(raw) {
  if (raw === 'google' || raw === 'local' || raw === 'both') return raw;
  return 'both';
}

function createSafeBrowsingService(options = {}) {
  const userDataPath = options.userDataPath || '';
  const listUrls =
    Array.isArray(options.listUrls) && options.listUrls.length
      ? options.listUrls
      : DEFAULT_LIST_URLS;
  const cachePath = userDataPath
    ? path.join(userDataPath, 'safe-browsing-blocklist.json')
    : '';
  const seedPath = path.join(__dirname, 'data', 'safe-browsing-seed.txt');

  let blockedHosts = new Set();
  let sessionAllowedHosts = new Set();
  let meta = {
    updatedAt: null,
    hostCount: 0,
    source: 'none',
    lastError: null,
    listUrls,
  };
  let refreshPromise = null;

  function loadCacheFromDisk() {
    if (!cachePath || !fs.existsSync(cachePath)) return false;
    try {
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const list = Array.isArray(raw.hosts) ? raw.hosts : [];
      blockedHosts = new Set(list.map(normalizeHostname).filter(Boolean));
      meta = {
        updatedAt: raw.updatedAt || null,
        hostCount: blockedHosts.size,
        source: raw.source || 'cache',
        lastError: null,
        listUrls,
      };
      return blockedHosts.size > 0;
    } catch (e) {
      meta.lastError = String(e.message || e);
      return false;
    }
  }

  function loadSeedFromDisk() {
    if (!fs.existsSync(seedPath)) return false;
    try {
      const text = fs.readFileSync(seedPath, 'utf8');
      blockedHosts = parseBlocklistText(text);
      meta = {
        updatedAt: null,
        hostCount: blockedHosts.size,
        source: 'seed',
        lastError: null,
        listUrls,
      };
      return blockedHosts.size > 0;
    } catch (e) {
      meta.lastError = String(e.message || e);
      return false;
    }
  }

  function saveCacheToDisk(source) {
    if (!cachePath) return;
    try {
      fs.writeFileSync(
        cachePath,
        JSON.stringify(
          {
            updatedAt: new Date().toISOString(),
            source,
            hosts: [...blockedHosts],
          },
          null,
          2
        )
      );
    } catch (e) {
      meta.lastError = String(e.message || e);
    }
  }

  function needsRefresh() {
    if (!meta.updatedAt) return true;
    const age = Date.now() - Date.parse(meta.updatedAt);
    return !Number.isFinite(age) || age > REFRESH_MAX_AGE_MS;
  }

  async function refreshBlocklist(force = false) {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      if (!force && !needsRefresh() && blockedHosts.size > 0) {
        return getStatus();
      }
      const merged = new Set();
      const errors = [];
      for (const listUrl of listUrls) {
        try {
          const text = await fetchText(listUrl);
          const parsed = parseBlocklistText(text);
          if (parsed.size === 0) {
            errors.push(`${listUrl}: empty`);
            continue;
          }
          for (const h of parsed) merged.add(h);
        } catch (e) {
          errors.push(`${listUrl}: ${e.message || e}`);
        }
      }
      if (merged.size > 0) {
        blockedHosts = merged;
        meta = {
          updatedAt: new Date().toISOString(),
          hostCount: blockedHosts.size,
          source: 'remote',
          lastError: errors.length ? errors.join('; ') : null,
          listUrls,
        };
        saveCacheToDisk('remote');
      } else {
        meta.lastError = errors.join('; ') || 'blocklist empty';
        if (blockedHosts.size === 0) {
          if (!loadCacheFromDisk() && !loadSeedFromDisk()) {
            meta.hostCount = 0;
          }
        }
      }
      return getStatus();
    })().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  function init() {
    if (!loadCacheFromDisk()) loadSeedFromDisk();
    void refreshBlocklist(false);
  }

  function allowHostForSession(urlOrHost) {
    const host =
      typeof urlOrHost === 'string' && urlOrHost.includes('://')
        ? hostnameFromUrl(urlOrHost)
        : normalizeHostname(urlOrHost);
    if (!host) return;
    sessionAllowedHosts.add(host);
  }

  function isAllowedForSession(hostname) {
    const h = normalizeHostname(hostname);
    if (!h) return false;
    if (sessionAllowedHosts.has(h)) return true;
    const parts = h.split('.');
    for (let i = 1; i < parts.length; i++) {
      if (sessionAllowedHosts.has(parts.slice(i).join('.'))) return true;
    }
    return false;
  }

  function checkUrlLocal(url) {
    const host = hostnameFromUrl(url);
    if (!host) return { blocked: false };
    if (!isHostBlocked(host, blockedHosts)) return { blocked: false };
    return {
      blocked: true,
      host,
      url: String(url),
      reason: 'deceptive',
      threatType: 'phishing',
      source: 'local',
      providerLabel: 'Local blocklist (CERT.PL + community)',
    };
  }

  async function checkUrl(url, options = {}) {
    const enabled = options.enabled !== false;
    if (!enabled) return { blocked: false };

    const host = hostnameFromUrl(url);
    if (!host) return { blocked: false };
    if (isAllowedForSession(host)) return { blocked: false };

    const provider = normalizeProviderMode(options.provider);
    const apiKey = String(options.googleApiKey || '').trim();
    const useGoogle =
      (provider === 'google' || provider === 'both') && apiKey.length > 0;
    const useLocal = provider === 'local' || provider === 'both';

    if (useGoogle) {
      const googleResult = await checkGoogleSafeBrowsingUrl(url, apiKey);
      if (googleResult.blocked) return googleResult;
      if (googleResult.error && provider === 'google') {
        return { blocked: false, source: 'google', error: googleResult.error };
      }
      if (provider === 'google') return { blocked: false, source: 'google' };
    } else if (provider === 'google' && !apiKey) {
      return {
        blocked: false,
        source: 'google',
        error: 'Google Safe Browsing API key not configured',
      };
    }

    if (useLocal) {
      return checkUrlLocal(url);
    }

    return { blocked: false };
  }

  function getStatus(options = {}) {
    const apiKey = String(options.googleApiKey || '').trim();
    return {
      ...meta,
      hostCount: blockedHosts.size,
      listUrls,
      googleConfigured: apiKey.length > 0,
      provider: normalizeProviderMode(options.provider),
    };
  }

  init();

  return {
    checkUrl,
    refreshBlocklist,
    allowHostForSession,
    getStatus,
    needsRefresh,
  };
}

module.exports = {
  createSafeBrowsingService,
  parseBlocklistText,
  hostnameFromUrl,
  CERT_PL_LIST_URL,
  PHISHING_DB_LIST_URL,
  DEFAULT_LIST_URLS,
};
