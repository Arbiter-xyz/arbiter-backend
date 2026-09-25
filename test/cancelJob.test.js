import './helpers/undo-test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, Transaction } from '@stellar/stellar-sdk';
import { startFulfillment, cancelJob, getJobStatus } from '../src/oracle.js';
import { registerWorker, unregisterWorker } from '../src/dispatch.js';
import { buildChallengeXdr, verifyChallengeAndIssueSession } from '../src/workerAuth.js';
import { getCreditBalanceStroops } from '../src/billing.js';
import { PRICING_TIERS } from '../src/pricing.js';
import { config } from '../src/config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextId = 9_000_000 + Math.floor(Math.random() * 100_000);
const newQuestionId = () => String(nextId++);

// A human-quorum tier with a tiny quorum window, so a job that DOES get
// dispatched in these tests settles (no-answers -> refund) in milliseconds
// instead of holding the test process open for 45s.
const FAST_TIER = { ...PRICING_TIERS.express, timeoutMs: 50 };
const pendingFor = (question) => ({ question, category: null });

async function sessionFor(keypair) {
  const tx = new Transaction(await buildChallengeXdr(keypair.publicKey()), config.networkPassphrase);
  tx.sign(keypair);
  const session = await verifyChallengeAndIssueSession(keypair.publicKey(), tx.toXDR());
  return session.token;
}

/** Waits until a job reaches `status`, or fails the test after `ms`. */
async function waitForStatus(jobId, status, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const job = await getJobStatus(jobId);
    if (job?.status === status) return job;
    await sleep(20);
  }
  assert.fail(`job ${jobId} never reached ${status} (last: ${(await getJobStatus(jobId))?.status})`);
}

function watchWorker(id) {
  const events = [];
  registerWorker(id, { write: (chunk) => events.push(chunk) }, []);
  return {
    questionsSeen: (qid) => events.filter((e) => e.startsWith('event: question') && e.includes(`"questionId":"${qid}"`)).length,
    stop: () => unregisterWorker(id),
  };
}

test('a paid human-quorum job starts in the holding state with a cancel deadline', async () => {
  const payer = Keypair.random();
  const qid = newQuestionId();
  const before = Date.now();
  const { jobId, cancellableUntil } = await startFulfillment(qid, pendingFor('hold me'), FAST_TIER, payer.publicKey());

  assert.equal(jobId, qid);
  assert.ok(cancellableUntil >= before + config.undoWindowMs && cancellableUntil <= Date.now() + config.undoWindowMs);
  const job = await getJobStatus(jobId);
  assert.equal(job.status, 'holding');
  assert.equal(job.cancellableUntil, cancellableUntil);

  await waitForStatus(jobId, 'settled');
});

test('the payer can cancel during the hold: refunded through the normal refund path, never dispatched', async () => {
  const payer = Keypair.random();
  const worker = watchWorker(`undo-worker-${Date.now()}`);
  try {
    const qid = newQuestionId();
    await startFulfillment(qid, pendingFor('oops, wrong question'), FAST_TIER, payer.publicKey());

    const result = await cancelJob(qid, { sessionToken: await sessionFor(payer) });
    assert.equal(result.ok, true);
    assert.equal(result.job.status, 'settled');
    assert.equal(result.job.cancelledByPayer, true);
    assert.equal(result.job.reconciliationMethod, 'cancelled-by-payer');
    assert.equal(result.job.reason, 'cancelled by the payer during the undo window');
    // No PLATFORM_SECRET in tests, so refund() itself fails and settleRefunded
    // falls back exactly as it does for every other refund: the payer is
    // pointed at refund_timeout(). With a real key this is 'refunded' + refundTx.
    assert.ok(['refunded', 'refund_pending_timeout'].includes(result.job.outcome));
    if (result.job.outcome === 'refund_pending_timeout') {
      assert.equal(result.job.autoRefundAfterLedgers, config.timeoutLedgers);
    }

    await sleep(config.undoWindowMs + 150);
    assert.equal(worker.questionsSeen(qid), 0, 'a cancelled question is never broadcast');
    assert.equal((await getJobStatus(qid)).status, 'settled');
  } finally {
    worker.stop();
  }
});

test('after the hold elapses the job dispatches exactly as before, and a late cancel is rejected', async () => {
  const payer = Keypair.random();
  const worker = watchWorker(`undo-worker-late-${Date.now()}`);
  try {
    const qid = newQuestionId();
    const started = Date.now();
    await startFulfillment(qid, pendingFor('let this one through'), FAST_TIER, payer.publicKey());

    await waitForStatus(qid, 'settled');
    assert.equal(worker.questionsSeen(qid), 1, 'dispatched to workers once the window closed');
    const job = await getJobStatus(qid);
    assert.ok(job.dispatchedAt - started >= config.undoWindowMs - 5, 'dispatch waited for the hold');
    assert.ok(job.dispatchedAt - started < config.undoWindowMs + 300, 'and only for the hold');
    assert.equal(job.reconciliationMethod, 'no-answers', 'the normal pipeline ran');

    const late = await cancelJob(qid, { sessionToken: await sessionFor(payer) });
    assert.equal(late.ok, false);
    assert.equal(late.status, 409);
  } finally {
    worker.stop();
  }
});

test('cancel during dispatch (after the hold, before settlement) is rejected as already dispatched', async () => {
  const payer = Keypair.random();
  const qid = newQuestionId();
  await startFulfillment(qid, pendingFor('slow quorum'), { ...FAST_TIER, timeoutMs: 400 }, payer.publicKey());
  await waitForStatus(qid, 'awaiting_workers');

  const result = await cancelJob(qid, { sessionToken: await sessionFor(payer) });
  assert.deepEqual(result, { ok: false, status: 409, error: 'already dispatched to workers — the undo window has closed' });
  await waitForStatus(qid, 'settled');
  assert.notEqual((await getJobStatus(qid)).cancelledByPayer, true);
});

test('only the payer can cancel: missing, invalid, or another address\'s session is refused', async () => {
  const payer = Keypair.random();
  const stranger = Keypair.random();
  const qid = newQuestionId();
  await startFulfillment(qid, pendingFor('mine'), FAST_TIER, payer.publicKey());

  for (const sessionToken of [undefined, 'not-a-token', await sessionFor(stranger)]) {
    const result = await cancelJob(qid, { sessionToken });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  }
  assert.equal((await getJobStatus(qid)).status, 'holding', 'a refused cancel leaves the hold untouched');
  await waitForStatus(qid, 'settled');
});

test('concurrent cancels from the payer settle the refund exactly once', async () => {
  const payer = Keypair.random();
  const qid = newQuestionId();
  await startFulfillment(qid, pendingFor('double tap'), FAST_TIER, payer.publicKey());
  const token = await sessionFor(payer);

  const results = await Promise.all(Array.from({ length: 5 }, () => cancelJob(qid, { sessionToken: token })));
  assert.equal(results.filter((r) => r.ok).length, 1);
  for (const r of results.filter((r) => !r.ok)) assert.equal(r.status, 409);
});

test('instant-tier jobs are never held and cannot be cancelled', async () => {
  const payer = Keypair.random();
  const qid = newQuestionId();
  const { cancellableUntil } = await startFulfillment(qid, pendingFor('fast draft'), PRICING_TIERS.instant, payer.publicKey());
  assert.equal(cancellableUntil, undefined);
  assert.notEqual((await getJobStatus(qid)).status, 'holding');

  const result = await cancelJob(qid, { sessionToken: await sessionFor(payer) });
  assert.deepEqual(result, { ok: false, status: 409, error: 'instant-tier questions have no undo window' });
  await waitForStatus(qid, 'settled');
});

test('API-key jobs are cancelled with the same API key, and the customer\'s credit is restored', async () => {
  const accountId = `acct_undo_${Date.now()}`;
  const poolAddress = Keypair.random();
  const qid = newQuestionId();
  await startFulfillment(qid, pendingFor('fiat question'), FAST_TIER, poolAddress.publicKey(), { apiKeyAccountId: accountId });

  assert.equal((await cancelJob(qid, {})).status, 401);
  assert.equal((await cancelJob(qid, { apiKeyAccountId: 'acct_someone_else' })).status, 401);
  assert.equal(
    (await cancelJob(qid, { sessionToken: await sessionFor(poolAddress) })).status,
    401,
    'a session for the pooled address cannot stand in for the customer',
  );

  const before = await getCreditBalanceStroops(accountId);
  const result = await cancelJob(qid, { apiKeyAccountId: accountId });
  assert.equal(result.ok, true);
  assert.equal(result.job.cancelledByPayer, true);
  assert.equal(await getCreditBalanceStroops(accountId), before + Number(FAST_TIER.priceStroops));
});

test('the job owner (API key account) is never exposed on the public job record', async () => {
  const qid = newQuestionId();
  await startFulfillment(qid, pendingFor('private'), FAST_TIER, Keypair.random().publicKey(), { apiKeyAccountId: 'acct_secret' });
  assert.ok(!JSON.stringify(await getJobStatus(qid)).includes('acct_secret'));
  await waitForStatus(qid, 'settled');
});

test('unknown jobs return 404', async () => {
  assert.deepEqual(await cancelJob('does-not-exist', { sessionToken: 'x' }), {
    ok: false,
    status: 404,
    error: 'unknown or expired jobId',
  });
});
