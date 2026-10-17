import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';

import {
  ReferralError,
  normalizeCode,
  getOrCreateReferralCode,
  getReferralCodeFor,
  lookupReferralCode,
  redeemReferralCode,
  referralStatus,
  getReferralSummary,
  listReferrers,
} from '../src/referrals.js';
import { store } from '../src/store.js';
import { config } from '../src/config.js';
import { recordOutcome } from '../src/dispatch.js';

const freshAddress = () => Keypair.random().publicKey();

test.beforeEach(async () => {
  await store.delete('known-referrers');
});

test('normalizeCode normalizes valid Crockford base32 referral codes and rejects excluded characters', () => {
  assert.equal(normalizeCode('  arb-23456789 '), 'ARB-23456789');
  assert.equal(normalizeCode('abcdefgh'), 'ARB-ABCDEFGH');
  // 'I', 'L', 'O', 'U' are excluded from Crockford base32
  assert.equal(normalizeCode('ARB-1234567I'), null);
  assert.equal(normalizeCode('ARB-1234567O'), null);
  assert.equal(normalizeCode('ARB-SHORT'), null);
  assert.equal(normalizeCode(null), null);
});

test('getOrCreateReferralCode validates Stellar address, is idempotent, and retries on code collisions (#283)', async () => {
  await assert.rejects(
    () => getOrCreateReferralCode('not-a-stellar-key'),
    (err) => err instanceof ReferralError && err.status === 400,
  );

  const owner1 = freshAddress();
  const minted1 = await getOrCreateReferralCode(owner1);
  const again1 = await getOrCreateReferralCode(owner1);
  assert.equal(minted1.code, again1.code);
  assert.equal(minted1.owner, owner1);
  assert.equal(minted1.uses, 0);

  // Simulate 4 collisions with owner1's code followed by a fresh code on the 5th attempt.
  const owner2 = freshAddress();
  const candidates = [
    minted1.code,
    minted1.code,
    minted1.code,
    minted1.code,
    'ARB-99998888',
  ];
  let idx = 0;
  const minted2 = await getOrCreateReferralCode(owner2, {
    codeGenerator: () => candidates[idx++],
  });
  assert.equal(minted2.code, 'ARB-99998888');
  assert.equal(idx, 5);

  // All 5 attempts colliding fails closed with 503.
  const owner3 = freshAddress();
  await assert.rejects(
    () =>
      getOrCreateReferralCode(owner3, {
        codeGenerator: () => minted1.code,
      }),
    (err) => err instanceof ReferralError && err.status === 503,
  );
  assert.equal(await getReferralCodeFor(owner3), null);
});

test('redeemReferralCode enforces self-referral, answer-history, idempotency, and single-code rules', async () => {
  const referrerA = freshAddress();
  const referrerB = freshAddress();
  const referee = freshAddress();
  const veteran = freshAddress();

  const codeA = await getOrCreateReferralCode(referrerA);
  const codeB = await getOrCreateReferralCode(referrerB);

  // Self-referral is rejected.
  await assert.rejects(
    () => redeemReferralCode(referrerA, codeA.code),
    (err) => err instanceof ReferralError && /cannot redeem their own/i.test(err.message),
  );

  // Unknown code returns 404.
  await assert.rejects(
    () => redeemReferralCode(referee, 'ARB-ZZZZZZZZ'),
    (err) => err instanceof ReferralError && err.status === 404,
  );

  // Worker with existing answer history cannot redeem a referral code (409).
  await recordOutcome(veteran, true);
  await assert.rejects(
    () => redeemReferralCode(veteran, codeA.code),
    (err) => err instanceof ReferralError && err.status === 409,
  );

  // First redemption succeeds; retry with the same code is idempotent.
  const first = await redeemReferralCode(referee, codeA.code.toLowerCase());
  assert.equal(first.referrer, referrerA);
  assert.equal(first.code, codeA.code);

  const retry = await redeemReferralCode(referee, codeA.code);
  assert.equal(retry.alreadyRedeemed, true);
  assert.equal((await lookupReferralCode(codeA.code)).uses, 1);

  // Switching to a second code is rejected with 409.
  await assert.rejects(
    () => redeemReferralCode(referee, codeB.code),
    (err) => err instanceof ReferralError && err.status === 409,
  );
});

test('redeemReferralCode enforces maxUsesPerCode cap under concurrent redemptions', async () => {
  const maxUses = config.referrals.maxUsesPerCode;
  const referrer = freshAddress();
  const { code } = await getOrCreateReferralCode(referrer);

  // Pre-seed uses to maxUses - 2 so only 2 remaining redemptions are allowed.
  await store.set(`referral-uses:${code}`, maxUses - 2);
  const referees = Array.from({ length: 5 }, () => freshAddress());

  const results = await Promise.allSettled(
    referees.map((r) => redeemReferralCode(r, code)),
  );

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 2);
  assert.equal(rejected.length, 3);
  for (const r of rejected) {
    assert.equal(r.reason instanceof ReferralError, true);
    assert.equal(r.reason.status, 409);
  }

  const updated = await lookupReferralCode(code);
  assert.equal(updated.uses, maxUses);
  assert.equal(updated.remaining, 0);
});

test('referralStatus, getReferralSummary, and listReferrers track pending, qualified, and disqualified referees', async () => {
  const workerRules = { minAnswersBeforeReputationGate: 5, minMatchRatio: 0.6 };
  assert.equal(referralStatus({ total: 0, matched: 0 }, false, workerRules), 'pending');
  assert.equal(referralStatus({ total: 4, matched: 4 }, false, workerRules), 'pending');
  assert.equal(referralStatus({ total: 5, matched: 4 }, false, workerRules), 'qualified');
  assert.equal(referralStatus({ total: 5, matched: 2 }, false, workerRules), 'disqualified');
  assert.equal(referralStatus({ total: 5, matched: 5 }, true, workerRules), 'disqualified');

  const referrer = freshAddress();
  const { code } = await getOrCreateReferralCode(referrer);
  const refPending = freshAddress();
  const refQualified = freshAddress();

  await redeemReferralCode(refPending, code);
  await redeemReferralCode(refQualified, code);

  const gate = config.worker.minAnswersBeforeReputationGate;
  for (let i = 0; i < gate; i += 1) {
    await recordOutcome(refQualified, true);
  }

  const summary = await getReferralSummary(referrer);
  assert.equal(summary.counts.pending, 1);
  assert.equal(summary.counts.qualified, 1);
  assert.equal(summary.counts.disqualified, 0);

  const table = await listReferrers();
  assert.equal(table.length, 1);
  assert.equal(table[0].referrer, referrer);
  assert.equal(table[0].qualified, 1);
  assert.equal(table[0].totalReferees, 2);
});
