'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Opt-in local file logger (set PULSE_LOG=1).
 */
const LOG_NAME = 'pulse.log';
const LOG_PATH = path.join(os.tmpdir(), LOG_NAME);

let enabled = process.env.PULSE_LOG === '1';

function logToFile(...args) {
  if (!enabled) return;
  const line =
    '[' + new Date().toISOString() + '] ' +
    args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') +
    '\n';
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    /* ignore */
  }
}

module.exports = { logToFile, LOG_PATH, setEnabled: (v) => { enabled = !!v; } };
