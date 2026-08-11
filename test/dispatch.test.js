import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerWorker,
  unregisterWorker,
  dispatchAndCollect,
  submitAnswer,
  broadcast,
  recordOutcome,
  checkConnectionRateLimit,
  onlineWorkerCount,
  computeSmoothedCount,
  isEstablishedWorker,
} from '../src/dispatch.js';

function fakeRes() {
  const events = [];
  return { events, write: (chunk) => events.push(chunk) };
}

test('quorum reached early resolves dispatchAndCollect before the timeout, with exactly the submitted answers', async () => {
  const w1 = fakeRes();
  const w2 = fakeRes();
  registerWorker('worker-1', w1, []);
  registerWorker('worker-2', w2, []);

  const collected = dispatchAndCollect('q-100', 'What color is the sky?', { quorumSize: 2, timeoutMs: 5000 });

  // Give broadcast's async eligibility check a tick to run.
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(submitAnswer('q-100', 'worker-1', 'blue'), true);
  assert.equal(submitAnswer('q-100', 'worker-2', 'blue'), true);

  const start = Date.now();
  const submissions = await collected;
  assert.ok(Date.now() - start < 4000, 'should resolve well before the 5s timeout once quorum is reached');
  assert.equal(submissions.length, 2);

  unregisterWorker('worker-1');
  unregisterWorker('worker-2');
});

test('a worker cannot answer twice, and answers after the question closes are rejected', async () => {
  const w1 = fakeRes();
  registerWorker('worker-3', w1, []);

  const collected = dispatchAndCollect('q-101', 'Q?', { quorumSize: 1, timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(submitAnswer('q-101', 'worker-3', 'first'), true);
  assert.equal(submitAnswer('q-101', 'worker-3', 'second'), false, 'duplicate answer from same worker rejected');

  await collected; // question now closed (quorum of 1 reached)
  assert.equal(submitAnswer('q-101', 'worker-3', 'late'), false, 'answer after close rejected');

  unregisterWorker('worker-3');
});

test('dispatchAndCollect never rejects and resolves with whatever arrived once the timeout elapses', async () => {
  const submissions = await dispatchAndCollect('q-102', 'Nobody will answer this', { quorumSize: 3, timeoutMs: 100 });
  assert.deepEqual(submissions, []);
});

test('category routing sends to matching specialists and to generalists', async () => {
  const generalist = fakeRes();
  const mathWorker = fakeRes();
  registerWorker('worker-gen-a', generalist, []);
  registerWorker('worker-math-a', mathWorker, ['math']);
  try {
    await broadcast('q-200', 'What is 9 * 9?', { category: 'math', quorumSize: 1, expiresInMs: 1000 });
    assert.equal(generalist.events.length, 1, 'generalists always receive broadcasts');
    assert.equal(mathWorker.events.length, 1, 'matching specialists receive broadcasts');
  } finally {
    unregisterWorker('worker-gen-a');
    unregisterWorker('worker-math-a');
  }
});

test('category routing fails open to everyone online when no one matches and no generalists are present', async () => {
  const historyWorker = fakeRes();
  registerWorker('worker-history-b', historyWorker, ['history']);
  try {
    // No worker declared "astrophysics" and no generalist is online — routing
    // must fail open to whoever is online rather than stranding the question
    // with zero recipients.
    await broadcast('q-201', 'Unrouted category', { category: 'astrophysics', quorumSize: 1, expiresInMs: 1000 });
    assert.equal(historyWorker.events.length, 1);
  } finally {
    unregisterWorker('worker-history-b');
  }
});

test('a worker with a poor track record is excluded from routing once eligible peers exist', async () => {
  const good = fakeRes();
  const bad = fakeRes();
  registerWorker('worker-good-c', good, []);
  registerWorker('worker-bad-c', bad, []);
  try {
    // Seed worker-bad-c with a poor match history (well past the default
    // WORKER_MIN_ANSWERS_BEFORE_REPUTATION_GATE / WORKER_MIN_MATCH_RATIO).
    for (let i = 0; i < 10; i += 1) await recordOutcome('worker-bad-c', false);
    await recordOutcome('worker-good-c', true);

    await broadcast('q-300', 'Routing should skip the bad worker', { quorumSize: 1, expiresInMs: 1000 });
    assert.equal(good.events.length, 1);
    assert.equal(bad.events.length, 0, 'low-reputation worker excluded once eligible peers exist');
  } finally {
    unregisterWorker('worker-good-c');
    unregisterWorker('worker-bad-c');
  }
});

test('reputation gating fails open rather than excluding every online worker', async () => {
  const bad = fakeRes();
  registerWorker('worker-bad-d', bad, []);
  try {
    for (let i = 0; i < 10; i += 1) await recordOutcome('worker-bad-d', false);

    // worker-bad-d is the ONLY worker online — reputation gating must fail
    // open rather than deliver the question to nobody.
    await broadcast('q-301', 'Only the bad worker is online', { quorumSize: 1, expiresInMs: 1000 });
    assert.equal(bad.events.length, 1, 'fails open to the only available worker rather than excluding everyone');
  } finally {
    unregisterWorker('worker-bad-d');
  }
});

test('SSE connection rate limiting caps connections per address within the window', async () => {
  const ip = `test-ip-${Date.now()}`;
  let allowedCount = 0;
  for (let i = 0; i < 10; i += 1) {
    if (await checkConnectionRateLimit(ip)) allowedCount += 1;
  }
  // Default WORKER_RATE_LIMIT_MAX_CONNECTIONS is 5.
  assert.equal(allowedCount, 5);
});

test('onlineWorkerCount reflects live registrations', () => {
  const before = onlineWorkerCount();
  registerWorker('worker-count-test', fakeRes(), []);
  assert.equal(onlineWorkerCount(), before + 1);
  unregisterWorker('worker-count-test');
  assert.equal(onlineWorkerCount(), before);
});

// --- Smoothed (trailing-average) worker supply, used for surge pricing ---
// instead of the instantaneous count, specifically so a worker cartel can't
// spike the price by disconnecting for a single instant right before a
// question is asked and reconnecting in time to answer.

test('computeSmoothedCount falls back to the live count when no samples exist yet (cold start)', () => {
  assert.equal(computeSmoothedCount([], 7), 7);
});

test('computeSmoothedCount averages the trailing samples, not the live count', () => {
  assert.equal(computeSmoothedCount([10, 10, 10], 0), 10);
  assert.equal(computeSmoothedCount([0, 10], 999), 5);
});

test('computeSmoothedCount is not moved by a single-instant dip the way the raw count would be', () => {
  // A cartel disconnecting for one sample tick out of a 12-sample window
  // barely moves the average — they'd need to stay offline for a large
  // fraction of the whole window to meaningfully spike the surge price.
  const samples = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 0];
  const smoothed = computeSmoothedCount(samples, 0);
  assert.ok(smoothed >= 9, `expected the single dip to barely move the average, got ${smoothed}`);
});

// --- established-worker check, used to gate reconcile.js's fast path ---

test('isEstablishedWorker is false for a worker with no answer history', async () => {
  assert.equal(await isEstablishedWorker(`brand-new-${Date.now()}`), false);
});

test('isEstablishedWorker becomes true once a worker crosses the configured answer threshold', async () => {
  const workerId = `graduating-worker-${Date.now()}`;
  // Default WORKER_MIN_ANSWERS_BEFORE_REPUTATION_GATE is 5.
  for (let i = 0; i < 4; i += 1) await recordOutcome(workerId, true);
  assert.equal(await isEstablishedWorker(workerId), false);
  await recordOutcome(workerId, true);
  assert.equal(await isEstablishedWorker(workerId), true);
});
