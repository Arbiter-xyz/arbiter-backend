import test from 'node:test';
import assert from 'node:assert/strict';

import {
  recordPaymentReversal,
  getPaymentReversals,
  listPaymentReversals,
} from '../src/paymentReversals.js';
import { store } from '../src/store.js';

test.beforeEach(async () => {
  await store.delete('known-reversal-accounts');
});

test('recordPaymentReversal, getPaymentReversals, and listPaymentReversals index reversals per account and cap history at 50', async () => {
  const acctA = `acct_rev_a_${Date.now()}`;
  const acctB = `acct_rev_b_${Date.now()}`;

  await recordPaymentReversal(acctA, {
    type: 'charge.refunded',
    amountCents: 500,
    chargeId: 'ch_1',
  });
  await recordPaymentReversal(acctA, {
    type: 'charge.dispute.created',
    amountCents: 1500,
    chargeId: 'ch_2',
  });
  await recordPaymentReversal(acctB, {
    type: 'charge.refunded',
    amountCents: 200,
    chargeId: 'ch_3',
  });

  const revsA = await getPaymentReversals(acctA);
  assert.equal(revsA.length, 2);
  // Newest first
  assert.equal(revsA[0].chargeId, 'ch_2');
  assert.equal(revsA[1].chargeId, 'ch_1');
  assert.equal(typeof revsA[0].recordedAt, 'number');

  const all = await listPaymentReversals();
  assert.equal(all.length, 2);
  assert.equal(all[0].accountId, acctB);
  assert.equal(all[1].accountId, acctA);

  // Bounded at MAX_TRACKED_PER_ACCOUNT = 50
  for (let i = 0; i < 55; i += 1) {
    await recordPaymentReversal(acctB, { type: 'charge.refunded', chargeId: `ch_bulk_${i}` });
  }
  const boundedB = await getPaymentReversals(acctB);
  assert.equal(boundedB.length, 50);
  assert.equal(boundedB[0].chargeId, 'ch_bulk_54');
});
