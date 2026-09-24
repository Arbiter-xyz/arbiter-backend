#!/usr/bin/env node
/**
 * Independently verifies a settled question's provenance — see
 * src/provenance.js for the design and docs/provenance.md for a worked
 * example. Needs no backend config: it only imports the pure verification
 * module, so a third party can run it from a plain clone after `npm ci`.
 *
 *   node scripts/verify-provenance.js --backend <url> --job <jobId> [--horizon <url> | --rpc <url>] [--contract <id>]
 *   node scripts/verify-provenance.js --file <provenance.json> [--expected-hash <hex>] [--horizon <url> | --rpc <url>]
 *
 * Exit code 0 = every check passed, 1 = at least one failed, 2 = usage or
 * fetch error.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { rpc } from '@stellar/stellar-sdk';
import { verifyProvenance, extractContractCall, verifyPayout } from '../src/provenanceVerify.js';

const USAGE = `usage:
  node scripts/verify-provenance.js --backend <url> --job <jobId> [--horizon <url> | --rpc <url>] [--contract <id>]
  node scripts/verify-provenance.js --file <provenance.json> [--expected-hash <hex>] [--horizon <url> | --rpc <url>] [--contract <id>]`;

const { values: opts } = parseArgs({
  options: {
    backend: { type: 'string' },
    job: { type: 'string' },
    file: { type: 'string' },
    'expected-hash': { type: 'string' },
    horizon: { type: 'string' },
    rpc: { type: 'string' },
    contract: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

function die(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

/** Base64 envelope XDR of a settled transaction. Horizon keeps full
 * history; Soroban RPC only keeps a retention window (days, not forever),
 * so prefer --horizon for anything older. */
async function fetchEnvelope(txHash) {
  if (opts.horizon) {
    const tx = await getJson(`${opts.horizon.replace(/\/$/, '')}/transactions/${txHash}`);
    return tx.envelope_xdr;
  }
  const server = new rpc.Server(opts.rpc, { allowHttp: opts.rpc.startsWith('http://') });
  const tx = await server.getTransaction(txHash);
  if (tx.status !== 'SUCCESS') throw new Error(`RPC getTransaction(${txHash}) -> ${tx.status} (outside the RPC retention window? try --horizon)`);
  return tx.envelopeXdr;
}

function report(title, checks) {
  console.log(`\n${title}`);
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${!c.ok && c.detail ? `  [${c.detail}]` : ''}`);
}

async function main() {
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (!opts.file && !(opts.backend && opts.job)) die('either --file, or both --backend and --job, are required');

  let entry;
  let expectedHash = opts['expected-hash'];
  if (opts.file) {
    entry = JSON.parse(await readFile(opts.file, 'utf8'));
  } else {
    const base = opts.backend.replace(/\/$/, '');
    entry = await getJson(`${base}/oracle/${encodeURIComponent(opts.job)}/provenance`);
    // The job record is the second, independently-served copy of the hash.
    // Job records expire (JOB_RESULT_TTL_MS); provenance doesn't.
    const job = await getJson(`${base}/oracle/${encodeURIComponent(opts.job)}`).catch(() => null);
    if (job?.provenanceHash && expectedHash === undefined) expectedHash = job.provenanceHash;
    if (!job) console.log('note: job record not found (expired?), so there is no second copy of the hash to compare against');
  }

  const { record, settlement } = entry;
  console.log(`Question ${record.questionId}: ${JSON.stringify(record.question)}`);
  console.log(`Method: ${record.reconciliation.method} · submissions: ${record.submissions.length} · decision: ${record.decision.action}`);
  console.log(`Committed hash: ${entry.hash}`);

  const provenance = verifyProvenance(entry, { expectedHash });
  report('Commitment and re-derivation', provenance.checks);
  let ok = provenance.ok;

  const txHash = settlement?.payoutTx || settlement?.refundTx;
  if (opts.horizon || opts.rpc) {
    if (!txHash) {
      console.log('\nOn-chain settlement: no settlement tx recorded (refund_pending_timeout, or not settled yet), skipped');
    } else {
      const call = extractContractCall(await fetchEnvelope(txHash));
      const payout = verifyPayout(record, call);
      if (opts.contract) {
        payout.checks.push({ name: 'settled on the expected contract', ok: call.contractId === opts.contract, detail: call.contractId });
        payout.ok = payout.checks.every((c) => c.ok);
      }
      report(`On-chain settlement (${txHash})`, payout.checks);
      ok = ok && payout.ok;
    }
  } else if (txHash) {
    console.log(`\nOn-chain settlement: pass --horizon or --rpc to check tx ${txHash} against this record`);
  }

  console.log(`\n${ok ? 'VERIFIED' : 'VERIFICATION FAILED'}`);
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(2);
  });
