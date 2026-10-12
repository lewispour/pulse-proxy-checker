'use strict';

/**
 * Free proxy list fetcher. Pulls HTTP/HTTPS proxies from public, no-auth,
 * frequently-updated sources (GitHub raw lists + ProxyScrape API), tolerates
 * individual source failures, dedupes, and returns normalized `http://host:port`
 * strings ready for the existing checker.
 *
 * All sources return plain text, one `host:port` per line.
 */

const fetch = require('node-fetch');
const { logToFile } = require('./logger');

// Public source lists per protocol. Each returns plain `host:port` per line.
// (HTTPS proxies are served from the same HTTP lists — they're CONNECT-capable
//  HTTP proxies — so https reuses the http set.)
const SOURCES = {
  http: [
    { name: 'TheSpeedX', url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt' },
    { name: 'monosans', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt' },
    { name: 'proxifly', url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt' },
    { name: 'proxyscrape', url: 'https://api.proxyscrape.com/v3/free-proxy-list/get?request=getproxies&protocol=http&proxy_format=ipport&format=text' },
  ],
  socks4: [
    { name: 'TheSpeedX', url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt' },
    { name: 'monosans', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt' },
    { name: 'proxyscrape', url: 'https://api.proxyscrape.com/v3/free-proxy-list/get?request=getproxies&protocol=socks4&proxy_format=ipport&format=text' },
  ],
  socks5: [
    { name: 'TheSpeedX', url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt' },
    { name: 'monosans', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt' },
    { name: 'proxifly', url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt' },
    { name: 'proxyscrape', url: 'https://api.proxyscrape.com/v3/free-proxy-list/get?request=getproxies&protocol=socks5&proxy_format=ipport&format=text' },
  ],
};
// https proxies come from the http lists (same CONNECT-capable servers).
SOURCES.https = SOURCES.http;

const FETCH_TIMEOUT = 15000;
// Matches a bare host:port (optionally with a scheme prefix we strip).
const LINE_RE = /^(?:[a-z0-9]+:\/\/)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/i;

/** Fetch one source; resolves to an array of `host:port` (empty on failure). */
async function fetchSource(src) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(src.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Pulse/1.0.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const lines = parseLines(text);
    logToFile('fetched source', src.name, lines.length);
    return lines;
  } catch (err) {
    logToFile('source failed', src.name, (err && err.message) || 'error');
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Extract valid `host:port` pairs from a text blob. */
function parseLines(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const port = parseInt(m[2], 10);
    const octetsOk = m[1].split('.').every((o) => Number(o) <= 255);
    if (octetsOk && port >= 1 && port <= 65535) out.push(`${m[1]}:${m[2]}`);
  }
  return out;
}

/**
 * Fetch free proxies for a protocol from all its sources in parallel, dedupe,
 * and normalize to `<scheme>://host:port`.
 * @param {string} protocol one of http|https|socks4|socks5 (default http)
 * @returns {{ proxies: string[], perSource: object, protocol: string }}
 */
async function fetchFreeProxies(protocol) {
  const proto = SOURCES[protocol] ? protocol : 'http';
  const list = SOURCES[proto];
  const results = await Promise.allSettled(list.map(fetchSource));

  const perSource = {};
  const seen = new Set();
  const proxies = [];

  results.forEach((r, i) => {
    const got = r.status === 'fulfilled' ? r.value : [];
    perSource[list[i].name] = got.length;
    for (const hp of got) {
      if (!seen.has(hp)) {
        seen.add(hp);
        proxies.push(`${proto}://${hp}`);
      }
    }
  });

  logToFile('fetchFreeProxies', proto, proxies.length, perSource);
  return { proxies, perSource, protocol: proto };
}

module.exports = { fetchFreeProxies, parseLines, SOURCES };
