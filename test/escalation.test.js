import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerWorker,
  unregisterWorker,
  dispatchEscalating,
  submitAnswer,
  recordOutcome,
  decideEscalation,
  singleAnswerConfidence,
} from '../src/dispatch.js';
import { PRICING_TIERS, priceForTier, effectiveEscalatedPriceStroops, listTiersForClient } from '../src/pricing.js';
import { reserveCredit, settleReservation, getCreditBalanceStroops } from '../src/billing.js';

const base = { targetSize: 1, maxQuorum: 5, threshold: 0.8, singleConfidence: 0, allAgree: false };

// ---- decideEscalation: pure branch coverage ----------------------------

test('decideEscalation waits when nothing has arrived', () => {
  assert.deepEqual(decideEscalation({ ...base, submissionCount: 0 }), { action: 'wait' });
});

test('a lone answer at/above the threshold settles early', () => {
  const d = decideEscalation({ ...base, submissionCount: 1, singleConfidence: 0.8 });
  assert.deepEqual(d, { action: 'settle', reason: 'confident-single-answer' });
});

test('a lone answer below the threshold escalates 1 -> 3', () => {
  const d = decideEscalation({ ...base, submissionCount: 1, singleConfidence: 0.79 });
  assert.deepEqual(d, { action: 'escalate', newTarget: 3 });
});

test('after escalating, a still-lone answer waits for the bigger quorum instead of re-escalating', () => {
  const d = decideEscalation({ ...base, targetSize: 3, submissionCount: 1, singleConfidence: 0.1 });
  assert.deepEqual(d, { action: 'wait' });
});

test('escalated quorum settles once full and unanimous', () => {
  assert.deepEqual(decideEscalation({ ...base, targetSize: 3, submissionCount: 2, allAgree: true }), { action: 'wait' });
  assert.deepEqual(decideEscalation({ ...base, targetSize: 3, submissionCount: 3, allAgree: true }), {
    action: 'settle',
    reason: 'quorum-agreement',
  });
});

test('a full but split quorum escalates again, up to the cap, then settles', () => {
  assert.deepEqual(decideEscalation({ ...base, targetSize: 3, submissionCount: 3 }), { action: 'escalate', newTarget: 5 });
  assert.deepEqual(decideEscalation({ ...base, targetSize: 5, submissionCount: 5 }), { action: 'settle', reason: 'max-quorum' });
});

test('growth never exceeds maxQuorum', () => {
  assert.deepEqual(decideEscalation({ ...base, maxQuorum: 2, submissionCount: 1 }), { action: 'escalate', newTarget: 2 });
});

// ---- singleAnswerConfidence -------------------------------------------

test('unestablished workers carry zero confidence regardless of ratio', () => {
  assert.equal(singleAnswerConfidence({ matched: 4, total: 4 }, 5), 0);
  assert.equal(singleAnswerConfidence({ matched: 0, total: 0 }, 5), 0);
});

test('established confidence is Laplace-smoothed and drops with misses', () => {
  assert.ok(Math.abs(singleAnswerConfidence({ matched: 5, total: 5 }, 5) - 6 / 7) < 1e-9);
  assert.ok(singleAnswerConfidence({ matched: 5, total: 5 }, 5) >= 0.8);
  assert.ok(singleAnswerConfidence({ matched: 4, total: 5 }, 5) < 0.8);
  assert.ok(singleAnswerConfidence({ matched: 50, total: 50 }, 5) > singleAnswerConfidence({ matched: 5, total: 5 }, 5));
});

// ---- dispatchEscalating end to end (fake SSE workers, real state machine) -

function fakeRes() {
  const events = [];
  return { events, write: (c) => events.push(c) };
}
const ESC = { initialQuorum: 1, maxQuorum: 5, confidenceThreshold: 0.8, stepTimeoutMs: 60_000 };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function establish(id) {
  for (let i = 0; i < 6; i++) await recordOutcome(id, true);
}

test('settles early on one confident answer and never asks the rest of the pool', async () => {
  const ids = ['esc-a-1', 'esc-a-2', 'esc-a-3'];
  const res = ids.map(() => fakeRes());
  await establish(ids[0]);
  ids.forEach((id, i) => registerWorker(id, res[i], []));

  const p = dispatchEscalating('esc-q-1', 'Is water wet?', { timeoutMs: 5000, escalation: ESC });
  await tick();
  // Only the established worker was recruited.
  assert.equal(res[0].events.length, 1);
  assert.equal(res[1].events.length, 0);
  assert.equal(res[2].events.length, 0);

  assert.equal(submitAnswer('esc-q-1', ids[0], 'yes'), true);
  const out = await p;
  ids.forEach(unregisterWorker);

  assert.equal(out.submissions.length, 1);
  assert.equal(out.recruitedWorkers, 1);
  assert.equal(out.finalQuorumSize, 1);
  assert.equal(out.settledBy, 'confident-single-answer');
  assert.ok(out.confidence >= 0.8);
  assert.equal(out.submissions[0].established, true);
});

test('escalates when the lone answer is from an unproven worker, then settles on the agreeing quorum', async () => {
  const ids = ['esc-b-1', 'esc-b-2', 'esc-b-3', 'esc-b-4'];
  const res = ids.map(() => fakeRes());
  ids.forEach((id, i) => registerWorker(id, res[i], []));

  const p = dispatchEscalating('esc-q-2', 'Capital of France?', { timeoutMs: 5000, escalation: ESC });
  await tick();
  assert.equal(res.filter((r) => r.events.length === 1).length, 1);
  const first = ids[res.findIndex((r) => r.events.length === 1)];

  submitAnswer('esc-q-2', first, 'Paris');
  await tick(80);
  // Escalated 1 -> 3: two MORE workers recruited, the first not re-asked.
  assert.equal(res.filter((r) => r.events.length === 1).length, 3);
  assert.equal(res[ids.indexOf(first)].events.length, 1);

  const recruited = ids.filter((id, i) => id !== first && res[i].events.length === 1);
  assert.equal(submitAnswer('esc-q-2', recruited[0], 'paris'), true);
  assert.equal(submitAnswer('esc-q-2', recruited[1], 'Paris'), true);

  const out = await p;
  ids.forEach(unregisterWorker);
  assert.equal(out.submissions.length, 3);
  assert.equal(out.recruitedWorkers, 3);
  assert.equal(out.finalQuorumSize, 3);
  assert.equal(out.settledBy, 'quorum-agreement');
});

test('recruits only as many workers as are online when the target outgrows the pool', async () => {
  const ids = ['esc-c-1', 'esc-c-2'];
  const res = ids.map(() => fakeRes());
  ids.forEach((id, i) => registerWorker(id, res[i], []));

  const p = dispatchEscalating('esc-q-3', 'q', { timeoutMs: 400, escalation: ESC });
  await tick();
  submitAnswer('esc-q-3', ids[0], 'a'); // unproven -> escalate to 3 with only one more worker available
  const out = await p; // times out
  ids.forEach(unregisterWorker);
  assert.equal(out.recruitedWorkers, 2);
  assert.equal(out.finalQuorumSize, 3);
  assert.equal(out.settledBy, 'timeout');
});

test('a silent initial recruit is widened after stepTimeoutMs', async () => {
  const ids = ['esc-d-1', 'esc-d-2', 'esc-d-3'];
  const res = ids.map(() => fakeRes());
  ids.forEach((id, i) => registerWorker(id, res[i], []));

  const p = dispatchEscalating('esc-q-4', 'q', { timeoutMs: 600, escalation: { ...ESC, stepTimeoutMs: 100 } });
  await tick(250);
  assert.equal(res.filter((r) => r.events.length === 1).length, 3);
  const out = await p;
  ids.forEach(unregisterWorker);
  assert.equal(out.submissions.length, 0);
  assert.equal(out.recruitedWorkers, 3);
});

// ---- variable-quorum pricing ------------------------------------------

const auto = PRICING_TIERS.auto;

test('auto tier is quoted at the ceiling: the full-cap price, same per-worker rate as priority', () => {
  assert.equal(auto.quorumSize, auto.escalation.maxQuorum);
  assert.equal(auto.priceStroops, PRICING_TIERS.priority.priceStroops);
  assert.equal(priceForTier('auto', 100).priceStroops, auto.priceStroops);
  const listed = listTiersForClient().find((t) => t.key === 'auto');
  assert.equal(listed.escalating, true);
  assert.equal(listed.maxQuorum, 5);
  assert.equal(listTiersForClient().find((t) => t.key === 'standard').escalating, undefined);
});

test('effective price: fewer workers than the ceiling costs proportionally less', () => {
  assert.equal(effectiveEscalatedPriceStroops(auto, 1), auto.priceStroops / 5n);
  assert.equal(effectiveEscalatedPriceStroops(auto, 3), (auto.priceStroops * 3n) / 5n);
});

test('effective price: the full cap equals the ceiling, and nothing can exceed it or go below one worker', () => {
  assert.equal(effectiveEscalatedPriceStroops(auto, 5), auto.priceStroops);
  assert.equal(effectiveEscalatedPriceStroops(auto, 50), auto.priceStroops);
  assert.equal(effectiveEscalatedPriceStroops(auto, 0), auto.priceStroops / 5n);
});

test('effective price scales with the surge-adjusted ceiling that was actually charged', () => {
  const surged = priceForTier('auto', 0); // 2x surge
  assert.equal(effectiveEscalatedPriceStroops(surged, 1), surged.priceStroops / 5n);
});

test('fixed tiers are unaffected: effective price is always the quoted price', () => {
  const std = PRICING_TIERS.standard;
  assert.equal(effectiveEscalatedPriceStroops(std, 1), std.priceStroops);
  assert.equal(std.escalation, undefined);
});

async function meteredRun(recruited) {
  const acct = `acct-esc-${recruited}-${Math.random().toString(36).slice(2)}`;
  const ceiling = Number(auto.priceStroops);
  const reservation = ceiling * 2; // tier price * MAX_SURGE_MULTIPLIER, as server.js reserves
  const { store } = await import('../src/store.js');
  await store.incrBy(`credit:${acct}`, reservation);

  assert.equal(await reserveCredit(acct, reservation), true);
  await settleReservation(acct, reservation, ceiling); // askMetered charged the ceiling
  assert.equal(await getCreditBalanceStroops(acct), ceiling, 'after charge: only the surge headroom is back');

  // dispatch finished: hand back ceiling - effective, mirroring server.js's onEffectiveCost hook
  await settleReservation(acct, ceiling, Number(effectiveEscalatedPriceStroops(auto, recruited)));
  return { balance: await getCreditBalanceStroops(acct), ceiling };
}

test('metered flow: settling with fewer workers than the ceiling refunds the unused portion', async () => {
  const { balance, ceiling } = await meteredRun(1);
  const effective = ceiling / 5;
  assert.equal(balance, ceiling + (ceiling - effective)); // 1/2 of the reservation headroom + 4/5 refund
});

test('metered flow: with the cap fully reached, nothing beyond the surge headroom is refunded', async () => {
  const { balance, ceiling } = await meteredRun(5);
  assert.equal(balance, ceiling);
});

test('startFulfillment persists recruited count + effective price on the job and fires onEffectiveCost', async () => {
  const { startFulfillment } = await import('../src/oracle.js');
  const { getJob } = await import('../src/jobs.js');
  const id = ['esc-w-1', 'esc-w-2'];
  id.forEach((w) => registerWorker(w, fakeRes(), []));

  const qid = `esc-job-${Date.now()}`;
  const tier = { ...auto, timeoutMs: 300, escalation: { ...auto.escalation, stepTimeoutMs: 60_000 } };
  let hookValue;
  await startFulfillment(qid, { question: 'q', category: null }, tier, null, { onEffectiveCost: (v) => { hookValue = v; } });

  let job;
  for (let i = 0; i < 40 && !job?.effectiveAmountStroops; i++) {
    await tick(50);
    job = await getJob(qid);
  }
  id.forEach(unregisterWorker);

  assert.equal(job.escalating, true);
  assert.equal(job.amountStroops, auto.priceStroops.toString(), 'charged ceiling is unchanged');
  assert.equal(job.recruitedWorkers, 1);
  assert.equal(job.effectiveAmountStroops, (auto.priceStroops / 5n).toString());
  assert.equal(hookValue, auto.priceStroops / 5n);
});
