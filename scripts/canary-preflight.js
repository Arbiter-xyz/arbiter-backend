#!/usr/bin/env node
/**
 * Pre-promotion check for a canary (#89). Fetches GET /health from both
 * instances and refuses (exit 1) unless they point at the same contract,
 * platform account and network, both reach the same kind of shared Redis,
 * and the two URLs really are two different instances.
 *
 *   node scripts/canary-preflight.js https://primary.example.com https://canary.example.com
 *
 * See docs/runbooks/canary-deployment.md for where this fits.
 */
import { comparePreflight } from '../src/canary.js';

async function fetchFingerprint(baseUrl) {
  const res = await fetch(new URL('/health', baseUrl), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${baseUrl}/health returned ${res.status}`);
  const body = await res.json();
  return { body, fingerprint: body.deployment ?? null };
}

async function main() {
  const [primaryUrl, canaryUrl] = process.argv.slice(2);
  if (!primaryUrl || !canaryUrl) {
    console.error('usage: node scripts/canary-preflight.js <primary-base-url> <canary-base-url>');
    process.exit(2);
  }

  const [primary, canary] = await Promise.all([fetchFingerprint(primaryUrl), fetchFingerprint(canaryUrl)]);
  const problems = comparePreflight(primary.fingerprint, canary.fingerprint);
  if (primary.body.draining) problems.push('primary is already draining');

  console.log('primary:', JSON.stringify(primary.fingerprint, null, 2));
  console.log('canary: ', JSON.stringify(canary.fingerprint, null, 2));
  if (problems.length) {
    console.error('\nNOT safe to promote:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('\nOK: canary matches primary (contract, platform address, network, shared Redis).');
}

main().catch((err) => {
  console.error(`preflight failed: ${err.message}`);
  process.exit(1);
});
