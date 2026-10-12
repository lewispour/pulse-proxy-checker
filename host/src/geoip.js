'use strict';

/**
 * Local IP geolocation + ASN lookup using bundled DB-IP Lite .mmdb databases.
 * Fully offline, no rate limits.
 *
 * Databases (data/*.mmdb) are DB-IP Lite (CC-BY), downloaded monthly:
 *   dbip-country.mmdb  -> country code / name
 *   dbip-asn.mmdb      -> ASN number + organization (ISP)
 */

const fs = require('fs');
const path = require('path');
const maxmind = require('maxmind');

function dbPath(name) {
  return path.join(__dirname, '..', 'data', name);
}

// Load an .mmdb via readFileSync + Reader(buffer). This works both from a normal
// filesystem AND from inside a vercel/pkg snapshot (pkg supports fs.readFileSync
// on bundled assets, but maxmind.open's mmap-style path read does not).
function openDb(name) {
  const buf = fs.readFileSync(dbPath(name));
  return new maxmind.Reader(buf);
}

let countryDb = null;
let asnDb = null;
let loadPromise = null;

async function ensureLoaded() {
  if (countryDb && asnDb) return;
  if (!loadPromise) {
    loadPromise = Promise.resolve().then(() => {
      try { countryDb = openDb('dbip-country.mmdb'); } catch { countryDb = null; }
      try { asnDb = openDb('dbip-asn.mmdb'); } catch { asnDb = null; }
    });
  }
  await loadPromise;
}

// Regional-indicator flag emoji from a 2-letter country code.
function flagEmoji(cc) {
  if (!cc || cc.length !== 2) return '';
  const A = 0x1f1e6;
  return String.fromCodePoint(
    A + (cc.toUpperCase().charCodeAt(0) - 65),
    A + (cc.toUpperCase().charCodeAt(1) - 65)
  );
}

// Keywords that mark an ASN org as datacenter/hosting (higher risk, less residential).
const HOSTING_RE = /\b(hosting|datacenter|data center|cloud|server|vps|colo|dedicated|ovh|hetzner|digitalocean|linode|vultr|amazon|aws|google|azure|microsoft|alibaba|tencent|leaseweb|contabo|choopa|m247|gcore|cdn)\b/i;

/**
 * Look up an IP locally.
 * @returns {{countryCode, country, flag, asn, isp, hosting}}
 */
async function lookup(ip) {
  await ensureLoaded();
  let countryCode = null, country = null, asn = null, isp = null;
  try {
    const c = countryDb && countryDb.get(ip);
    if (c && c.country) { countryCode = c.country.iso_code || null; country = (c.country.names && c.country.names.en) || null; }
  } catch { /* ignore */ }
  try {
    const a = asnDb && asnDb.get(ip);
    if (a) { asn = a.autonomous_system_number || null; isp = a.autonomous_system_organization || null; }
  } catch { /* ignore */ }
  const hosting = isp ? HOSTING_RE.test(isp) : false;
  return { countryCode, country, flag: flagEmoji(countryCode), asn, isp, hosting };
}

module.exports = { lookup, flagEmoji, ensureLoaded };
