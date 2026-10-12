'use strict';

/**
 * CLI front-end for the engine — useful for testing without the Tauri shell.
 *
 *   node src/cli.js proxies.txt
 *   echo "1.2.3.4:8080:user:pass" | node src/cli.js -
 *   node src/cli.js --test-url https://ifconfig.me/ip --concurrency 50 proxies.txt
 */

const fs = require('fs');
const { checkProxies, DEFAULT_TIMEOUT, DEFAULT_CONCURRENCY, DEFAULT_TEST_URL } = require('./checker');

function parseArgs(argv) {
  const opts = {
    concurrency: DEFAULT_CONCURRENCY,
    timeoutMs: DEFAULT_TIMEOUT,
    testUrl: DEFAULT_TEST_URL,
    input: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--concurrency') opts.concurrency = parseInt(argv[++i], 10);
    else if (a === '--timeout') opts.timeoutMs = parseInt(argv[++i], 10);
    else if (a === '--test-url') opts.testUrl = argv[++i];
    else opts.input = a;
  }
  return opts;
}

function readLines(input) {
  const raw = input === '-' || !input
    ? fs.readFileSync(0, 'utf8')
    : fs.readFileSync(input, 'utf8');
  return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

async function run(argv) {
  const opts = parseArgs(argv);
  const lines = readLines(opts.input);
  process.stderr.write(`Checking ${lines.length} proxies (concurrency=${opts.concurrency}, test=${opts.testUrl})\n`);

  let working = 0;
  const results = await checkProxies(lines, opts, (r, done, total) => {
    if (r.ok) working++;
    const tag = r.ok ? 'OK ' : 'DEAD';
    const extra = r.ok ? `${r.latencyMs}ms exit=${r.exitIp}${r.anonymous ? ' anon' : ''}` : r.error;
    process.stderr.write(`[${done}/${total}] ${tag} ${r.raw}  ${extra}\n`);
  });

  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  process.stderr.write(`\nDone: ${working}/${results.length} working\n`);
}

if (require.main === module) run(process.argv.slice(2));

module.exports = { run };
