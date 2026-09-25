import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import {
  registerWorker,
  unregisterWorker,
  broadcast,
  dispatchAndCollect,
  submitAnswer,
  recordOutcome,
  hasOnlineWhitelistedWorker,
} from '../src/dispatch.js';
import { startFulfillment, getJobStatus } from '../src/oracle.js';
import { addPoolWorkers } from '../src/privatePools.js';
import { nextQuestionId } from '../src/pendingQuestions.js';

const addr = () => Keypair.random().publicKey();

function fakeRes() {
  const events = [];
  return { events, write: (chunk) => events.push(chunk) };
}

function withWorkers(specs) {
  const handles = specs.map(([id, categories = []]) => {
    const res = fakeRes();
    registerWorker(id, res, categories);
    return res;
  });
  return { handles, cleanup: () => specs.forEach(([id]) => unregisterWorker(id)) };
}

async function waitForSettled(jobId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await getJobStatus(jobId);
    if (job?.status === 'settled') return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${jobId} did not settle in time`);
}

// --- selectTargets()/broadcast() with a whitelist ---

test('a whitelist restricts broadcast to whitelisted online workers only', async () => {
  const [inPool, outside] = [addr(), addr()];
  const { handles, cleanup } = withWorkers([[inPool], [outside]]);
  try {
    const targets = await broadcast('pp-1', 'private question', { quorumSize: 1, expiresInMs: 1000, whitelist: [inPool] });
    assert.deepEqual(targets, [inPool]);
    assert.equal(handles[0].events.length, 1);
    assert.equal(handles[1].events.length, 0, 'a worker outside the pool never sees the question');
  } finally {
    cleanup();
  }
});

test('no whitelist (payer without a pool) broadcasts to the open pool unchanged', async () => {
  const [a, b] = [addr(), addr()];
  const { handles, cleanup } = withWorkers([[a], [b]]);
  try {
    const targets = await broadcast('pp-2', 'open question', { quorumSize: 1, expiresInMs: 1000 });
    assert.ok(targets.includes(a) && targets.includes(b));
    assert.equal(handles[0].events.length, 1);
    assert.equal(handles[1].events.length, 1);
  } finally {
    cleanup();
  }
});

test('zero online whitelisted workers FAILS CLOSED: nobody is broadcast to, not the open pool', async () => {
  const offlinePoolMember = addr();
  const outside = addr();
  const { handles, cleanup } = withWorkers([[outside]]);
  try {
    assert.equal(hasOnlineWhitelistedWorker([offlinePoolMember]), false);
    const targets = await broadcast('pp-3', 'private question', {
      quorumSize: 1,
      expiresInMs: 1000,
      whitelist: [offlinePoolMember],
    });
    assert.deepEqual(targets, []);
    assert.equal(handles[0].events.length, 0, 'must not fall back to the open pool');
  } finally {
    cleanup();
  }
});

test('category routing still fails open, but only as far as the whitelisted set', async () => {
  const poolHistorian = addr();
  const outsideGeneralist = addr();
  const { handles, cleanup } = withWorkers([[poolHistorian, ['history']], [outsideGeneralist]]);
  try {
    // Nobody in the pool does 'math': fall back to the whole pool, never to
    // the non-whitelisted generalist.
    await broadcast('pp-4', 'What is 9*9?', { category: 'math', quorumSize: 1, expiresInMs: 1000, whitelist: [poolHistorian] });
    assert.equal(handles[0].events.length, 1);
    assert.equal(handles[1].events.length, 0);
  } finally {
    cleanup();
  }
});

test('reputation gating still fails open, but only as far as the whitelisted set', async () => {
  const badPoolMember = addr();
  const goodOutsider = addr();
  const { handles, cleanup } = withWorkers([[badPoolMember], [goodOutsider]]);
  try {
    for (let i = 0; i < 10; i += 1) await recordOutcome(badPoolMember, false);
    await recordOutcome(goodOutsider, true);
    await broadcast('pp-5', 'private question', { quorumSize: 1, expiresInMs: 1000, whitelist: [badPoolMember] });
    assert.equal(handles[0].events.length, 1, 'the only whitelisted worker still gets it');
    assert.equal(handles[1].events.length, 0, 'a well-reputed outsider is still excluded');
  } finally {
    cleanup();
  }
});

// --- dispatchAndCollect()/submitAnswer() with a whitelist ---

test('a non-whitelisted worker cannot answer a private question even if they know its id', async () => {
  const [inPool, outside] = [addr(), addr()];
  const { cleanup } = withWorkers([[inPool], [outside]]);
  try {
    const collected = dispatchAndCollect('pp-6', 'private question', { quorumSize: 1, timeoutMs: 2000, whitelist: [inPool] });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(submitAnswer('pp-6', outside, 'sneaky'), false);
    assert.equal(submitAnswer('pp-6', inPool, 'legit'), true);
    const submissions = await collected;
    assert.deepEqual(submissions.map((s) => s.workerId), [inPool]);
  } finally {
    cleanup();
  }
});

test('dispatchAndCollect closes immediately with no submissions when no whitelisted worker is online', async () => {
  const { cleanup } = withWorkers([[addr()]]);
  try {
    const start = Date.now();
    const submissions = await dispatchAndCollect('pp-7', 'private question', { quorumSize: 1, timeoutMs: 5000, whitelist: [addr()] });
    assert.deepEqual(submissions, []);
    assert.ok(Date.now() - start < 2000, 'should not wait out the 5s timeout');
  } finally {
    cleanup();
  }
});

// --- end to end through oracle.js's startFulfillment() ---

const tier = { key: 'standard', quorumSize: 1, timeoutMs: 300, priceStroops: 1n };

test("a payer's registered pool routes their question only to whitelisted workers", async () => {
  const payer = addr();
  const [inPool, outside] = [addr(), addr()];
  await addPoolWorkers(payer, [inPool]);
  const { handles, cleanup } = withWorkers([[inPool], [outside]]);
  try {
    const questionId = (await nextQuestionId()).toString();
    await startFulfillment(questionId, { question: 'private?', category: null }, tier, payer);
    const job = await waitForSettled(questionId);

    assert.equal(handles[0].events.length, 1, 'whitelisted worker received the question');
    assert.equal(handles[1].events.length, 0, 'non-whitelisted worker did not');
    assert.equal(job.privatePool, true);
    assert.equal(job.privatePoolSize, 1);
  } finally {
    cleanup();
  }
});

test('a payer with no pool dispatches to the open pool exactly as before', async () => {
  const payer = addr();
  const [a, b] = [addr(), addr()];
  const { handles, cleanup } = withWorkers([[a], [b]]);
  try {
    const questionId = (await nextQuestionId()).toString();
    await startFulfillment(questionId, { question: 'open?', category: null }, tier, payer);
    const job = await waitForSettled(questionId);

    assert.equal(handles[0].events.length, 1);
    assert.equal(handles[1].events.length, 1);
    assert.equal(job.privatePool, undefined, 'no private-pool fields on an open-pool job');
  } finally {
    cleanup();
  }
});

test('a pool with zero online members refunds without broadcasting to anyone', async () => {
  const payer = addr();
  await addPoolWorkers(payer, [addr()]); // registered, but never connects
  const outside = addr();
  const { handles, cleanup } = withWorkers([[outside]]);
  try {
    const questionId = (await nextQuestionId()).toString();
    await startFulfillment(questionId, { question: 'private?', category: null }, { ...tier, timeoutMs: 60_000 }, payer);
    const job = await waitForSettled(questionId);

    assert.equal(handles[0].events.length, 0, 'never falls back to the open pool');
    assert.equal(job.reconciliationMethod, 'no-private-pool-workers');
    assert.match(job.reason, /private pool/);
    // No chain is configured in tests, so the admin refund() itself fails and
    // the job lands in refund_pending_timeout; either way it is a refund.
    assert.ok(['refunded', 'refund_pending_timeout'].includes(job.outcome));
    assert.equal(job.totalAnswers, 0);
  } finally {
    cleanup();
  }
});
