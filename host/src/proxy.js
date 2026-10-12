'use strict';

/**
 * Proxy string parsing. Accepts these formats:
 *
 *   host:port
 *   host:port:user:pass
 *   host:port@user:pass
 *   scheme://host:port
 *   scheme://user:pass@host:port
 *
 * Supported schemes: http, https, socks4, socks4a, socks5, socks5h.
 */

const SUPPORTED_SCHEMES = ['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h'];
const DEFAULT_SCHEME = 'http';

// scheme://user:pass@host:port
const RE_SCHEME_AUTH = /^(\w+):\/\/([\w.-]+):(.*)@([\w.-]+):(\d+)$/;
// scheme://host:port
const RE_SCHEME_PLAIN = /^(\w+):\/\/([\w.-]+):(\d+)$/;
// host:port@user:pass  (host:port BEFORE the @)
const RE_HOSTPORT_AUTH = /^([\w.-]+):(\d+)@([\w.-]+):(.*)$/;
// user:pass@host:port  (host:port AFTER the @ — standard URL order, no scheme)
const RE_AUTH_HOSTPORT = /^([^:@]+):(.*)@([\w.-]+):(\d+)$/;
// host:port:user:pass
const RE_HOSTPORT_COLON = /^([\w.-]+):(\d+):([^:]+):(.*)$/;
// host:port
const RE_HOSTPORT = /^([\w.-]+):(\d+)$/;

/**
 * @typedef {Object} ParsedProxy
 * @property {string} scheme
 * @property {string} host
 * @property {number} port
 * @property {string|null} username
 * @property {string|null} password
 * @property {string} raw
 */

/** Parse a single proxy line into a normalized object, or null if unparseable. */
function parseProxy(line) {
  const raw = String(line).trim();
  if (!raw) return null;

  let m;

  if ((m = RE_SCHEME_AUTH.exec(raw))) {
    return build(m[1], m[4], m[5], m[2], m[3], raw);
  }
  if ((m = RE_SCHEME_PLAIN.exec(raw))) {
    return build(m[1], m[2], m[3], null, null, raw);
  }
  if ((m = RE_HOSTPORT_AUTH.exec(raw))) {
    // host:port@user:pass  (numeric port before @)
    return build(DEFAULT_SCHEME, m[1], m[2], m[3], m[4], raw);
  }
  if ((m = RE_AUTH_HOSTPORT.exec(raw))) {
    // user:pass@host:port  (numeric port after @ — standard order, no scheme)
    return build(DEFAULT_SCHEME, m[3], m[4], m[1], m[2], raw);
  }
  if ((m = RE_HOSTPORT_COLON.exec(raw))) {
    // host:port:user:pass
    return build(DEFAULT_SCHEME, m[1], m[2], m[3], m[4], raw);
  }
  if ((m = RE_HOSTPORT.exec(raw))) {
    return build(DEFAULT_SCHEME, m[1], m[2], null, null, raw);
  }
  return null;
}

function build(scheme, host, port, username, password, raw) {
  scheme = normalizeScheme(scheme);
  const p = parseInt(port, 10);
  if (!host || !Number.isInteger(p) || p < 1 || p > 65535) return null;
  return {
    scheme,
    host,
    port: p,
    username: username || null,
    password: password || null,
    raw,
  };
}

function normalizeScheme(s) {
  s = String(s || '').toLowerCase();
  return SUPPORTED_SCHEMES.includes(s) ? s : DEFAULT_SCHEME;
}

/** Build a connection URL (with userinfo) used by the proxy agents. */
function toProxyUrl(p) {
  const auth = p.username
    ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password || '')}@`
    : '';
  return `${p.scheme}://${auth}${p.host}:${p.port}`;
}

function isSocks(p) {
  return p.scheme.startsWith('socks');
}

module.exports = { parseProxy, toProxyUrl, isSocks, SUPPORTED_SCHEMES, DEFAULT_SCHEME };
