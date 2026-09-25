import test from 'node:test';
import assert from 'node:assert/strict';
import {
  undoWindowFor,
  holdThenDispatch,
  cancelHeld,
  claimUndoDecision,
  getUndoDecision,
} from '../src/undoWindow.js';
import { PRICING_TIERS } from '../src/pricing.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

test('undoWindowFor: holds every human-quorum tier, never instant, and 0 disables it', () => {
  assert.equal(undoWindowFor(PRICING_TIERS.standard, 5000), 5000);
  assert.equal(undoWindowFor(PRICING_TIERS.express, 5000), 5000);
  assert.equal(undoWindowFor(PRICING_TIERS.priority, 5000), 5000);
  assert.equal(undoWindowFor(PRICING_TIERS.instant, 5000), 0);
  assert.equal(undoWindowFor(PRICING_TIERS.standard, 0), 0);
  assert.equal(undoWindowFor(PRICING_TIERS.standard, -10), 0);
  assert.equal(undoWindowFor(undefined, 5000), 0);
});

test('never cancelled: dispatch runs once the hold elapses, and not before', async () => {
  const jobId = uid('hold-normal');
  let dispatchedAt = null;
  const start = Date.now();
  holdThenDispatch(jobId, 150, async () => {
    dispatchedAt = Date.now();
  });

  await sleep(80);
  assert.equal(dispatchedAt, null, 'nothing dispatched during the hold');

  await sleep(200);
  assert.ok(dispatchedAt, 'dispatched after the hold');
  const delay = dispatchedAt - start;
  assert.ok(delay >= 145 && delay < 400, `dispatch delayed only by the hold (took ${delay}ms)`);
  assert.equal(await getUndoDecision(jobId), 'dispatch');
});

test('cancel during the hold refunds and dispatch never runs', async () => {
  const jobId = uid('hold-cancel');
  let dispatched = false;
  let refunded = 0;
  holdThenDispatch(jobId, 150, async () => {
    dispatched = true;
  });

  await sleep(30);
  const result = await cancelHeld(jobId, async () => {
    refunded += 1;
  });
  assert.deepEqual(result, { cancelled: true });
  assert.equal(refunded, 1);

  await sleep(250);
  assert.equal(dispatched, false, 'the hold timer must not dispatch a cancelled job');
  assert.equal(await getUndoDecision(jobId), 'cancel');
});

test('cancel after the hold is rejected and never refunds', async () => {
  const jobId = uid('hold-late');
  let dispatched = 0;
  holdThenDispatch(jobId, 50, async () => {
    dispatched += 1;
  });
  await sleep(120);

  let refunded = false;
  const result = await cancelHeld(jobId, async () => {
    refunded = true;
  });
  assert.deepEqual(result, { cancelled: false });
  assert.equal(refunded, false);
  assert.equal(dispatched, 1);
});

test('racing cancels and dispatch: exactly one decision wins, never both', async () => {
  for (let round = 0; round < 20; round += 1) {
    const jobId = uid('hold-race');
    const outcomes = await Promise.all([
      claimUndoDecision(jobId, 'dispatch'),
      ...Array.from({ length: 5 }, () => claimUndoDecision(jobId, 'cancel')),
    ]);
    assert.equal(outcomes.filter(Boolean).length, 1, 'exactly one claim wins');
  }
});

test('concurrent cancel requests refund exactly once', async () => {
  const jobId = uid('hold-double-cancel');
  let dispatched = false;
  holdThenDispatch(jobId, 150, async () => {
    dispatched = true;
  });

  let refunds = 0;
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      cancelHeld(jobId, async () => {
        refunds += 1;
      }),
    ),
  );
  assert.equal(results.filter((r) => r.cancelled).length, 1);
  assert.equal(refunds, 1, 'no double refund');
  await sleep(200);
  assert.equal(dispatched, false);
});

test('an error thrown by dispatch goes to onError instead of escaping the timer', async () => {
  const jobId = uid('hold-error');
  const errors = [];
  holdThenDispatch(
    jobId,
    20,
    async () => {
      throw new Error('boom');
    },
    (err) => errors.push(err.message),
  );
  await sleep(80);
  assert.deepEqual(errors, ['boom']);
});
