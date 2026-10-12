#!/usr/bin/env node
'use strict';

/**
 * Pulse engine host — entry point.
 *
 * Operates in two modes:
 *   1. Native-messaging host (default): reads length-prefixed JSON from stdin,
 *      writes results to stdout. Message protocol:
 *        in : { type: "proxy-check", id, proxies: [...], options: {...} }
 *        out: { type: "proxy-progress", id, result, done, total }
 *             { type: "proxy-check-result", id, results: [...] }
 *   2. CLI (`--cli` or when launched with proxy args) — see cli.js.
 */

const { createReader, send } = require('./framing');
const { checkProxies } = require('./checker');
const { fetchFreeProxies } = require('./sources');
const { logToFile } = require('./logger');

// Proxy agents can emit 'error' on a raw socket AFTER the fetch has already
// settled (e.g. a dead proxy resetting the TLS connection late). Such events
// have no listener and would otherwise crash the whole engine with an uncaught
// exception, killing an entire check run. Swallow them — the relevant proxy has
// already been recorded as dead by its own try/catch.
process.on('uncaughtException', (err) => {
  logToFile('uncaughtException (ignored)', err && err.message);
});
process.on('unhandledRejection', (err) => {
  logToFile('unhandledRejection (ignored)', err && (err.message || String(err)));
});

/** Fisher-Yates shuffle (returns a new array). */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startNativeMessagingHost() {
  logToFile('host started (native messaging mode)');

  const onMessage = async (msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'ping') {
      send(process.stdout, { type: 'pong', id: msg.id });
      return;
    }

    if (msg.type === 'proxy-check') {
      const id = msg.id;
      const proxies = Array.isArray(msg.proxies) ? msg.proxies : [];
      const options = msg.options || {};
      logToFile('proxy-check', { id, count: proxies.length, options });

      const results = await checkProxies(proxies, options, (result, done, total) => {
        send(process.stdout, { type: 'proxy-progress', id, result, done, total });
      });

      send(process.stdout, { type: 'proxy-check-result', id, results });
      logToFile('proxy-check-result', { id, count: results.length });
      return;
    }

    // Fetch free proxies from public sources and return the raw list.
    if (msg.type === 'fetch-free') {
      const id = msg.id;
      const { proxies, perSource } = await fetchFreeProxies(msg.protocol);
      send(process.stdout, { type: 'fetch-free-result', id, proxies, perSource });
      return;
    }

    // Fetch free proxies, check them, stream progress, return only working ones.
    if (msg.type === 'find-alive') {
      const id = msg.id;
      const options = msg.options || {};
      const { proxies: all, perSource } = await fetchFreeProxies(msg.protocol);

      // limit <= 0 (or missing) means "check all". Otherwise sample `limit` at
      // random (shuffled so we span sources, not always the same head).
      const limit = options.limit && options.limit > 0 ? options.limit : 0;
      const proxies = limit > 0 ? shuffle(all).slice(0, limit) : all;
      send(process.stdout, { type: 'fetch-free-result', id, proxies, perSource, fetched: all.length, checking: proxies.length });

      const results = await checkProxies(proxies, options, (result, done, total) => {
        send(process.stdout, { type: 'proxy-progress', id, result, done, total });
      });
      const alive = results.filter((r) => r.ok);
      send(process.stdout, { type: 'find-alive-result', id, results, alive });
      logToFile('find-alive-result', { id, total: results.length, alive: alive.length });
      return;
    }

    send(process.stdout, { type: 'error', id: msg.id, error: 'unknown message type: ' + msg.type });
  };

  const reader = createReader((m) => {
    Promise.resolve(onMessage(m)).catch((e) => {
      logToFile('handler error', e && e.message);
      send(process.stdout, { type: 'error', error: (e && e.message) || 'handler error' });
    });
  });

  process.stdin.on('data', reader);
  process.stdin.on('end', () => {
    logToFile('stdin ended, exiting');
    process.exit(0);
  });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--cli')) {
    require('./cli').run(args.filter((a) => a !== '--cli'));
  } else {
    startNativeMessagingHost();
  }
}

module.exports = { startNativeMessagingHost };
