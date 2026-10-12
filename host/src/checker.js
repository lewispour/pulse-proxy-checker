'use strict';

/**
 * Proxy checking engine. Built on https-proxy-agent, socks-proxy-agent and
 * node-fetch with bounded concurrency. For each proxy it:
 *   1. gets the EXIT IP through the proxy from lightweight IP reflectors
 *      (rotating list with fallback — works for http/https/socks4/socks5),
 *   2. geolocates the exit IP LOCALLY via bundled DB-IP Lite .mmdb (no API limits),
 *   3. computes Quality % and Risk (Low/Medium/High) locally.
 */

const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const fetch = require('node-fetch');
const { parseProxy, toProxyUrl, isSocks } = require('./proxy');
const geoip = require('./geoip');

const DEFAULT_TIMEOUT = 15000; // ms
const DEFAULT_CONCURRENCY = 25;

// Lightweight IP reflectors: each returns ONLY the caller's IP (plain text), no
// geo, effectively unlimited (requests exit via different proxy IPs). We rotate
// a starting point per proxy and fall back through the list until one answers.
// HTTP endpoints are preferred first since HTTP-only proxies can't CONNECT to HTTPS.
const REFLECTORS = [
  'http://icanhazip.com/',
  'http://checkip.amazonaws.com/',
  'http://ifconfig.me/ip',
  'https://api.ipify.org/?format=text',
  'https://icanhazip.com/',
];
const DEFAULT_TEST_URL = null; // use the reflector rotation

let __reflectorCursor = 0;

/** The machine's own public IP (fetched once, directly) for an anonymity check. */
let directIpCache = null;
async function getDirectIp(timeoutMs) {
  if (directIpCache !== null) return directIpCache;
  try {
    const { ip } = await probeReflectors(null, timeoutMs);
    directIpCache = ip || '';
  } catch {
    directIpCache = '';
  }
  return directIpCache;
}

function makeAgent(parsed) {
  if (isSocks(parsed)) {
    return new SocksProxyAgent(toProxyUrl(parsed), { timeout: DEFAULT_TIMEOUT });
  }
  // Both `http` and `https` proxies are plain-HTTP proxy servers: the connection
  // TO the proxy is unencrypted. The `https` scheme only means the proxy can
  // CONNECT-tunnel HTTPS targets. Using `https://` as the proxy URL makes the
  // agent attempt a TLS handshake to the proxy itself → EPROTO "wrong version
  // number". So always address the proxy over http://.
  const auth = parsed.username
    ? `${encodeURIComponent(parsed.username)}:${encodeURIComponent(parsed.password || '')}@`
    : '';
  const proxyUrl = `http://${auth}${parsed.host}:${parsed.port}`;
  return new HttpsProxyAgent(proxyUrl);
}

/** Fetch one URL (optionally through a proxy agent); return {status, body}. */
async function fetchOnce(url, agent, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      agent: agent || undefined,
      signal: controller.signal,
      headers: { 'User-Agent': 'Pulse/1.0.0' },
      redirect: 'follow',
    });
    const body = await res.text().catch(() => '');
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try reflectors in rotating order until one returns a valid exit IP.
 * Returns { ip, reflector } — ip is null if none forwarded a valid IP.
 * Throws only if EVERY reflector failed at the connection level.
 */
async function probeReflectors(agent, timeoutMs) {
  const start = __reflectorCursor++ % REFLECTORS.length;
  const deadline = Date.now() + timeoutMs;   // TOTAL budget, shared across attempts
  let lastErr = null;

  for (let n = 0; n < REFLECTORS.length; n++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;                // out of total budget
    const url = REFLECTORS[(start + n) % REFLECTORS.length];
    try {
      const { body } = await fetchOnce(url, agent, remaining);
      const ip = extractIp(body);
      if (ip) return { ip, reflector: url };
      // Connected but this reflector returned a non-IP page (e.g. blocked it).
      // The proxy clearly WORKS, so try another reflector — but only if budget
      // remains. This is the only reason to retry.
    } catch (e) {
      // Connection-level failure through the proxy (refused/reset/timeout).
      // The proxy itself is dead/unreachable — trying other reflectors through
      // the same dead proxy is pointless and wastes the whole budget. Stop now.
      throw e;
    }
  }
  if (lastErr) throw lastErr;
  return { ip: null, reflector: null };
}

// Extract an exit IP from a reflector body. Null if it's not a bare IP echo.
function extractIp(body) {
  const t = String(body).trim();
  if (/<\s*html|<!doctype/i.test(t)) return null; // proxy error page
  try {
    const j = JSON.parse(t);
    if (j && typeof j.ip === 'string') return j.ip;
    if (j && typeof j.query === 'string') return j.query;
  } catch { /* not json */ }
  const m = t.match(/^\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$/) ||
            t.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  return m ? m[1] : null;
}

// Quality % (0-100) from latency, anonymity and whether the exit is a datacenter.
function computeQuality(latencyMs, anonymous, hosting) {
  // Latency: <=500ms -> ~55, scaling down to ~15 at 10s.
  const lat = Math.max(0, 55 - Math.min(55, (latencyMs / 10000) * 45));
  const anon = anonymous ? 30 : 0;           // hides your real IP
  const residential = hosting ? 0 : 15;      // residential > datacenter
  return Math.round(Math.max(1, Math.min(99, lat + anon + residential)));
}

function computeRisk(quality, hosting) {
  if (hosting && quality < 70) return 'High';
  if (quality >= 80) return 'Low';
  if (quality >= 55) return 'Medium';
  return 'High';
}

/**
 * Check one proxy. Returns a rich result record.
 */
async function checkProxy(line, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT;
  const parsed = parseProxy(line);
  if (!parsed) return deadResult(String(line).trim(), null, 'parse error');

  const started = Date.now();
  try {
    const agent = makeAgent(parsed);
    const { ip: exitIp } = await probeReflectors(agent, timeoutMs);
    const latencyMs = Date.now() - started;
    if (!exitIp) return deadResult(parsed.raw, parsed.scheme, 'not forwarding');

    const directIp = await getDirectIp(timeoutMs);
    const anonymous = directIp ? exitIp !== directIp : null;
    const geo = await geoip.lookup(exitIp);
    const quality = computeQuality(latencyMs, anonymous, geo.hosting);
    const risk = computeRisk(quality, geo.hosting);

    return {
      raw: parsed.raw,
      ok: true,
      status: 'working',
      scheme: parsed.scheme,
      latencyMs,
      exitIp,
      anonymous,
      countryCode: geo.countryCode,
      country: geo.country,
      flag: geo.flag,
      asn: geo.asn,
      isp: geo.isp,
      quality,
      risk,
      error: null,
    };
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? 'timeout' : (err && err.message) || 'error';
    return deadResult(parsed.raw, parsed.scheme, msg);
  }
}

function deadResult(raw, scheme, error) {
  return {
    raw, ok: false, status: 'dead', scheme,
    latencyMs: null, exitIp: null, anonymous: null,
    countryCode: null, country: null, flag: null, asn: null, isp: null,
    quality: null, risk: null, error,
  };
}

/**
 * Check many proxies with bounded concurrency. Calls onProgress(result, done, total)
 * after each completion, streaming a "proxy-progress" event per proxy.
 */
async function checkProxies(lines, opts = {}, onProgress) {
  const concurrency = Math.max(1, opts.concurrency || DEFAULT_CONCURRENCY);
  const items = lines.map((l) => String(l)).filter((l) => l.trim().length > 0);
  const total = items.length;
  const results = new Array(total);
  let next = 0;
  let done = 0;

  async function worker() {
    while (next < total) {
      const i = next++;
      const r = await checkProxy(items[i], opts);
      results[i] = r;
      done++;
      if (onProgress) {
        try { onProgress(r, done, total); } catch { /* ignore */ }
      }
    }
  }

  const workers = [];
  for (let k = 0; k < Math.min(concurrency, total); k++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

module.exports = {
  checkProxy,
  checkProxies,
  computeQuality,
  computeRisk,
  DEFAULT_TIMEOUT,
  DEFAULT_CONCURRENCY,
  DEFAULT_TEST_URL,
};
