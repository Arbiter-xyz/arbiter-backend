import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listTiersForClient,
  effectiveEscalatedPriceStroops,
  resolveTier,
} from '../src/pricing.js';
import {
  getSmoothedOnlineWorkerCount,
  dispatchAndCollect,
  hasOnlineWhitelistedWorker,
  dispatchEscalating,
  setCachedStake,
  computeSmoothedCount,
  decideEscalation,
  singleAnswerConfidence,
  buildSuggestionPayload,
  getWorkerConnectedAt,
  writePresence,
  readPresence,
  onlineWorkerCount,
  registerWorker,
  unregisterWorker,
} from '../src/dispatch.js';
import { isTerminalJob, reconcileJob, getClient } from '../src/reconcile.js';
import {
  createAccount,
  unsuspendAccount,
  SUPPORTED_CURRENCIES,
  resolveCurrency,
  webhookAmountToStroops,
  paypalProcessor,
  coinbaseProcessor,
} from '../src/billing.js';
import {
  DEFAULT_LIMIT,
  MAX_CONCURRENCY,
  mapWithConcurrency,
  computeFraudScore,
  getFraudScore,
  listTransactions,
  listWorkers,
  listAnchorPayouts,
  listAnchorKyc,
  provisionAccount,
  unsuspendKey,
} from '../src/admin.js';
import { createJob } from '../src/jobs.js';
import { store } from '../src/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('Issue #268: pricing.js exports listTiersForClient, effectiveEscalatedPriceStroops, and auto tier', () => {
  const tiers = listTiersForClient();
  assert.ok(Array.isArray(tiers) && tiers.length >= 4);
  const autoTier = tiers.find((t) => t.key === 'auto');
  assert.ok(autoTier, 'auto tier must be listed for clients');
  assert.equal(autoTier.escalating, true);
  assert.equal(autoTier.maxQuorum, 5);

  const resolvedAuto = resolveTier('auto');
  assert.equal(resolvedAuto.key, 'auto');
  assert.equal(resolvedAuto.escalation.maxQuorum, 5);

  assert.equal(
    effectiveEscalatedPriceStroops(resolvedAuto, 1),
    resolvedAuto.priceStroops / 5n,
  );
  assert.equal(
    effectiveEscalatedPriceStroops(resolvedAuto, 5),
    resolvedAuto.priceStroops,
  );
});

test('Issue #267 & #271: dispatch.js exports all expected symbols and writePresence creates per-worker TTL keys', async () => {
  assert.equal(typeof getSmoothedOnlineWorkerCount, 'function');
  assert.equal(typeof dispatchAndCollect, 'function');
  assert.equal(typeof hasOnlineWhitelistedWorker, 'function');
  assert.equal(typeof dispatchEscalating, 'function');
  assert.equal(typeof setCachedStake, 'function');
  assert.equal(typeof computeSmoothedCount, 'function');
  assert.equal(typeof decideEscalation, 'function');
  assert.equal(typeof singleAnswerConfidence, 'function');
  assert.equal(typeof buildSuggestionPayload, 'function');
  assert.equal(typeof getWorkerConnectedAt, 'function');

  // Verify writePresence creates presence:<workerId> with TTL and readPresence prunes expired entries
  const keys = new Map();
  const hashes = new Map();
  const ttls = new Map();
  const fakeRedis = {
    async set(k, v) { keys.set(k, v); },
    async get(k) { return keys.get(k) ?? null; },
    async expire(k, s) { ttls.set(k, s); },
    async hset(h, f, v) {
      if (!hashes.has(h)) hashes.set(h, new Map());
      hashes.get(h).set(f, v);
    },
    async hgetall(h) {
      return Object.fromEntries(hashes.get(h) || []);
    },
    async hdel(h, f) {
      hashes.get(h)?.delete(f);
    },
  };
  const origGetClient = store.getClient;
  store.getClient = () => fakeRedis;
  try {
    // Seed a stale worker in the hash whose per-worker TTL key has expired
    await fakeRedis.hset('presence:workers', 'stale-worker-271', JSON.stringify({ categories: ['general'], connectedAt: 1000 }));
    await writePresence('active-worker-271', ['general']);

    assert.ok(keys.has('presence:active-worker-271'), 'writePresence must create presence:<workerId> key');
    assert.ok(ttls.get('presence:active-worker-271') > 0, 'writePresence must set TTL on presence:<workerId>');

    const present = await readPresence();
    assert.ok(present.has('active-worker-271'));
    assert.ok(!present.has('stale-worker-271'), 'expired worker must be pruned from presence:workers');
    assert.equal(hashes.get('presence:workers').has('stale-worker-271'), false);
  } finally {
    store.getClient = origGetClient;
  }
});

test('Issue #269: oracle.js imports DEFAULT_CONSENSUS_MODE and dispatchEscalating without ReferenceError', async () => {
  const oracleMod = await import('../src/oracle.js');
  assert.equal(typeof oracleMod.issueChallengeIdempotent, 'function');
  assert.equal(typeof oracleMod.startFulfillment, 'function');
});

test('Issue #272: reconcile.js recognizes settled/refunded jobs via status and outcome fields', async () => {
  assert.equal(isTerminalJob({ status: 'settled', outcome: 'resolved' }), true);
  assert.equal(isTerminalJob({ status: 'settled', outcome: 'refunded' }), true);
  assert.equal(isTerminalJob({ status: 'awaiting_workers', outcome: null }), false);

  const qResolved = `q-272-res-${Date.now()}`;
  const settledJob = await createJob(qResolved, { status: 'settled', outcome: 'resolved', answer: '42', amountStroops: '1000000' });
  const r1 = await reconcileJob(settledJob, {
    getOnChainStatus: async () => 'Resolved',
    settleResolved: async () => {},
    settleRefunded: async () => {},
    markTerminal: async () => {},
  });
  assert.equal(r1, 'resolved');

  const qDrift = `q-272-drift-${Date.now()}`;
  const driftJob = await createJob(qDrift, { status: 'cancelling', outcome: null, amountStroops: '1000000' });
  let refundedCalled = false;
  const r2 = await reconcileJob(driftJob, {
    getOnChainStatus: async () => 'Open',
    settleResolved: async () => {},
    settleRefunded: async () => { refundedCalled = true; },
    markTerminal: async () => {},
  });
  assert.equal(r2, 'refunded');
  assert.equal(refundedCalled, true);
});

test('Issue #273: billing.js exports currency helpers and uses currency minorUnits for PayPal/Coinbase', () => {
  assert.ok(SUPPORTED_CURRENCIES.usd);
  assert.equal(SUPPORTED_CURRENCIES.jpy.minorUnits, 1);
  assert.equal(resolveCurrency('JPY').code, 'jpy');

  // 1500 JPY (zero-decimal currency, minorUnits = 1) with stroopsPerUnit = 67_000n
  const jpyStroops = webhookAmountToStroops('1500', {
    currency: 'jpy',
    minorUnits: 1,
    stroopsPerUnit: '67000',
  });
  assert.equal(jpyStroops, 1500n * 67_000n);

  // 10.50 USD (2-decimal currency, minorUnits = 100) with stroopsPerUnit = 10_000_000n
  const usdStroops = webhookAmountToStroops('10.50', {
    currency: 'usd',
    minorUnits: 100,
    stroopsPerUnit: '10000000',
  });
  assert.equal(usdStroops, 105_000_000n);

  assert.equal(paypalProcessor.name, 'paypal');
  assert.equal(coinbaseProcessor.name, 'coinbase');
});

test('Issue #270 & #122: admin.js exports helpers, provisions/unsuspends accounts, and computes worker fraud score', async () => {
  assert.equal(DEFAULT_LIMIT, 50);
  assert.equal(MAX_CONCURRENCY, 10);
  assert.equal(typeof getClient, 'function');

  const mapped = await mapWithConcurrency([1, 2, 3, 4], 2, async (x) => x * 10);
  assert.deepEqual(mapped, [10, 20, 30, 40]);

  const provisioned = await provisionAccount({ creditUsdc: 5 });
  assert.ok(provisioned.accountId.startsWith('acct_'));
  assert.ok(provisioned.apiKey.startsWith('ak_live_'));
  assert.equal(provisioned.credited, '5.0000000');

  const unsuspended = await unsuspendKey(provisioned.accountId);
  assert.equal(unsuspended.suspended, false);

  const lowRisk = computeFraudScore({
    totalAnswers: 20,
    matched: 19,
    maxCollusionScore: 0,
    collusionSuspended: false,
    stakeStroops: 100_000_000n,
    minStakeStroops: 10_000_000n,
  });
  assert.equal(lowRisk.level, 'low');
  assert.ok(lowRisk.score < 35);

  const highRisk = computeFraudScore({
    totalAnswers: 20,
    matched: 2,
    maxCollusionScore: 0.9,
    collusionSuspended: true,
    stakeStroops: 0n,
    minStakeStroops: 10_000_000n,
  });
  assert.equal(highRisk.level, 'high');
  assert.ok(highRisk.score >= 70);

  const report = await getFraudScore('worker-risk-check');
  assert.equal(report.workerId, 'worker-risk-check');
  assert.equal(typeof report.score, 'number');
  assert.ok(['low', 'medium', 'high'].includes(report.level));
});

test('Issue #252: server.js awaits onlineWorkerCount() in /health and /stats and mounts /admin/workers/:address/risk', async () => {
  const count = await onlineWorkerCount();
  assert.equal(typeof count, 'number');

  const serverSrc = await fs.readFile(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.match(serverSrc, /app\.get\('\/health',\s*async\s*\(req,\s*res\)\s*=>\s*\{[\s\S]*?await onlineWorkerCount\(\)/);
  assert.match(serverSrc, /app\.get\('\/stats',\s*async\s*\(req,\s*res\)\s*=>\s*\{[\s\S]*?onlineWorkerCount\(\)/);
  assert.match(serverSrc, /app\.get\('\/admin\/workers\/:address\/risk',\s*requireAdmin/);
});
