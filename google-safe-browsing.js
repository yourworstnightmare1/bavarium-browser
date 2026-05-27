'use strict';

const https = require('https');

const GOOGLE_SB_V4_FIND_URL =
  'https://safebrowsing.googleapis.com/v4/threatMatches:find';

const CLIENT_ID = 'bavarium-browser';
const CLIENT_VERSION = '3.0.0-b';

const THREAT_TYPES = [
  'MALWARE',
  'SOCIAL_ENGINEERING',
  'UNWANTED_SOFTWARE',
  'POTENTIALLY_HARMFUL_APPLICATION',
];

const NEGATIVE_CACHE_SEC = 5 * 60;
const POSITIVE_CACHE_FALLBACK_SEC = 30 * 60;

/** @type {Map<string, { blocked: boolean, expiresAt: number, payload?: object }>} */
const urlCache = new Map();

function parseCacheDurationSec(raw, fallbackSec) {
  if (!raw || typeof raw !== 'string') return fallbackSec;
  const m = raw.trim().match(/^([\d.]+)s$/i);
  if (!m) return fallbackSec;
  const sec = Math.round(parseFloat(m[1]));
  if (!Number.isFinite(sec)) return fallbackSec;
  return Math.max(60, Math.min(24 * 60 * 60, sec));
}

function cacheKeyForUrl(url) {
  return String(url || '').trim();
}

function mapGoogleThreatType(threatType) {
  switch (threatType) {
    case 'MALWARE':
      return 'malware';
    case 'SOCIAL_ENGINEERING':
      return 'phishing';
    case 'UNWANTED_SOFTWARE':
      return 'unwanted';
    case 'POTENTIALLY_HARMFUL_APPLICATION':
      return 'harmful';
    default:
      return 'unsafe';
  }
}

function hostnameFromUrl(url) {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.toLowerCase();
  } catch {
    return '';
  }
}

function postJson(url, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': 'Bavarium-Browser-SafeBrowsing/1.0',
        },
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          postJson(res.headers.location, body, timeoutMs).then(resolve, reject);
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(
              new Error(
                data
                  ? `Google Safe Browsing HTTP ${res.statusCode}: ${data.slice(0, 200)}`
                  : `Google Safe Browsing HTTP ${res.statusCode}`
              )
            );
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Invalid JSON from Google Safe Browsing: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Google Safe Browsing request timeout'));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Check a URL with Google Safe Browsing v4 Lookup API (threatMatches.find).
 * @see https://developers.google.com/safe-browsing/v4/lookup-api
 */
async function checkGoogleSafeBrowsingUrl(url, apiKey) {
  const text = String(url || '').trim();
  if (!text || !apiKey) return { blocked: false, source: 'google' };

  const key = cacheKeyForUrl(text);
  const cached = urlCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload || { blocked: false, source: 'google', cached: true };
  }

  const requestUrl = `${GOOGLE_SB_V4_FIND_URL}?key=${encodeURIComponent(apiKey)}`;
  const body = {
    client: {
      clientId: CLIENT_ID,
      clientVersion: CLIENT_VERSION,
    },
    threatInfo: {
      threatTypes: THREAT_TYPES,
      platformTypes: ['ANY_PLATFORM'],
      threatEntryTypes: ['URL'],
      threatEntries: [{ url: text }],
    },
  };

  let response;
  try {
    response = await postJson(requestUrl, body);
  } catch (e) {
    return {
      blocked: false,
      source: 'google',
      error: String(e.message || e),
    };
  }

  const matches = response && Array.isArray(response.matches) ? response.matches : [];
  if (matches.length > 0) {
    const match = matches[0];
    const cacheSec = parseCacheDurationSec(
      match.cacheDuration,
      POSITIVE_CACHE_FALLBACK_SEC
    );
    const host = hostnameFromUrl(text);
    const payload = {
      blocked: true,
      host,
      url: text,
      reason: 'deceptive',
      threatType: mapGoogleThreatType(match.threatType),
      source: 'google',
      googleThreatType: match.threatType || '',
      providerLabel: 'Google Safe Browsing',
    };
    urlCache.set(key, {
      blocked: true,
      expiresAt: Date.now() + cacheSec * 1000,
      payload,
    });
    return payload;
  }

  const payload = { blocked: false, source: 'google' };
  urlCache.set(key, {
    blocked: false,
    expiresAt: Date.now() + NEGATIVE_CACHE_SEC * 1000,
    payload,
  });
  return payload;
}

function clearGoogleSafeBrowsingCache() {
  urlCache.clear();
}

function getGoogleSafeBrowsingCacheSize() {
  return urlCache.size;
}

module.exports = {
  checkGoogleSafeBrowsingUrl,
  clearGoogleSafeBrowsingCache,
  getGoogleSafeBrowsingCacheSize,
  GOOGLE_SB_V4_FIND_URL,
};
