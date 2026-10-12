'use strict';
// Minimal self-contained tests (no framework). Run: node test/test.js
const assert = require('assert');
const { parseProxy, toProxyUrl } = require('../src/proxy');
const { encode, createReader } = require('../src/framing');
const { parseLines } = require('../src/sources');

let passed = 0;
function ok(name) { passed++; console.log('  ok -', name); }

// --- proxy parsing (all 3 UI-documented formats + bare) ---
assert.deepStrictEqual(
  pick(parseProxy('1.2.3.4:8080:user:pass')),
  { scheme: 'http', host: '1.2.3.4', port: 8080, username: 'user', password: 'pass' }
);
ok('host:port:user:pass');

assert.deepStrictEqual(
  pick(parseProxy('1.2.3.4:8080@user:pass')),
  { scheme: 'http', host: '1.2.3.4', port: 8080, username: 'user', password: 'pass' }
);
ok('host:port@user:pass');

assert.deepStrictEqual(
  pick(parseProxy('socks5://u:p@h.example.com:9050')),
  { scheme: 'socks5', host: 'h.example.com', port: 9050, username: 'u', password: 'p' }
);
ok('scheme://user:pass@host:port');

assert.strictEqual(parseProxy('5.6.7.8:1080').scheme, 'http');
ok('bare host:port defaults to http');

assert.strictEqual(parseProxy('garbage'), null);
ok('garbage -> null');

assert.strictEqual(toProxyUrl(parseProxy('socks5h://1.2.3.4:1080')), 'socks5h://1.2.3.4:1080');
ok('toProxyUrl roundtrip');

// --- native-messaging framing (uint32-LE length prefix + JSON) ---
(function () {
  const msg = { type: 'proxy-check', id: '1', proxies: ['1.2.3.4:8080'] };
  const framed = encode(msg);
  // header is 4 bytes LE length
  assert.strictEqual(framed.readUInt32LE(0), framed.length - 4);
  let received = null;
  const reader = createReader((m) => { received = m; });
  // feed in two chunks to exercise buffering
  reader(framed.subarray(0, 6));
  reader(framed.subarray(6));
  assert.deepStrictEqual(received, msg);
  ok('framing encode/decode across chunk boundary');
})();

// --- free-proxy source parsing ---
(function () {
  const blob = [
    '1.2.3.4:8080',
    'http://5.6.7.8:3128',     // scheme stripped
    '  9.10.11.12:80  ',       // trimmed
    'not-a-proxy',             // rejected
    '256.1.1.1:80',            // bad octet rejected
    '1.2.3.4:99999',           // bad port rejected
    'socks5://13.14.15.16:1080',
  ].join('\n');
  const parsed = parseLines(blob);
  assert.deepStrictEqual(parsed, ['1.2.3.4:8080', '5.6.7.8:3128', '9.10.11.12:80', '13.14.15.16:1080']);
  ok('sources.parseLines strips schemes, trims, rejects junk/bad-octet/bad-port');
})();

function pick(p) {
  return p && { scheme: p.scheme, host: p.host, port: p.port, username: p.username, password: p.password };
}

console.log(`\n${passed} tests passed`);
