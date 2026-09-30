#!/usr/bin/env node
/**
 * Operator CLI for the chain-driven recovery sweep (src/disasterRecovery.js,
 * docs/runbooks/disaster-recovery.md). Runs the same sweep the backend runs
 * on boot and every RECOVERY_SWEEP_INTERVAL_MS, without starting the server —
 * useful when the backend itself can't come up, or to preview what a
 * recovering backend is about to do.
 *
 * Reads the same .env as the backend (ORACLE_CONTRACT_ID, SOROBAN_RPC_URL,
 * NETWORK_PASSPHRASE, PLATFORM_SECRET, REDIS_URL).
 *
 *   node scripts/dr-sweep.js                 # dry run: classify, refund nothing
 *   node scripts/dr-sweep.js --execute       # refund what the sweep says to
 *   node scripts/dr-sweep.js --out report.json
 *
 * Exit code: 0 on success, 1 if the chain scan failed, 2 if any question was
 * flagged 'inconsistent' or any refund errored (i.e. a human needs to look).
 */
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const outIndex = args.indexOf('--out');
const outPath = outIndex >= 0 ? args[outIndex + 1] : null;

if (args.includes('--help')) {
  console.log('usage: node scripts/dr-sweep.js [--execute] [--out report.json]');
  process.exit(0);
}

const { config } = await import('../src/config.js');
const { store } = await import('../src/store.js');
const { runRecoverySweep, defaultRecoveryDeps } = await import('../src/disasterRecovery.js');

if (!config.contractId) {
  console.error('ORACLE_CONTRACT_ID is not set');
  process.exit(1);
}
if (execute && !config.platformSecret) {
  console.error('--execute needs PLATFORM_SECRET (refund() is admin-only)');
  process.exit(1);
}

let report;
try {
  report = await runRecoverySweep({
    store,
    deps: await defaultRecoveryDeps(),
    options: { ...config.recovery, dryRun: !execute },
  });
} catch (err) {
  console.error(`sweep failed: ${err.message}`);
  process.exit(1);
}
if (!report) {
  console.error('another instance holds the recovery sweep lock; try again shortly');
  process.exit(1);
}

const json = JSON.stringify(report, null, 2);
if (outPath) writeFileSync(outPath, json + '\n');
console.log(json);

const needsHuman = report.summary.flagged > 0 || report.summary.errors > 0;
process.exit(needsHuman ? 2 : 0);
