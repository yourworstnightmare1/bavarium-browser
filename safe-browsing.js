'use strict';

const { checkGoogleSafeBrowsingUrl } = require('./google-safe-browsing');

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

function createSafeBrowsingService() {
  let sessionAllowedHosts = new Set();

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

  async function checkUrl(url, options = {}) {
    const enabled = options.enabled !== false;
    if (!enabled) return { blocked: false };

    const host = hostnameFromUrl(url);
    if (!host) return { blocked: false };
    if (isAllowedForSession(host)) return { blocked: false };

    const apiKey = String(options.googleApiKey || '').trim();
    if (!apiKey) {
      return {
        blocked: false,
        source: 'google',
        error: 'Google Safe Browsing API key not configured',
      };
    }

    return checkGoogleSafeBrowsingUrl(url, apiKey);
  }

  function getStatus(options = {}) {
    const apiKey = String(options.googleApiKey || '').trim();
    return {
      googleConfigured: apiKey.length > 0,
    };
  }

  return {
    checkUrl,
    allowHostForSession,
    getStatus,
  };
}

module.exports = {
  createSafeBrowsingService,
  hostnameFromUrl,
};
