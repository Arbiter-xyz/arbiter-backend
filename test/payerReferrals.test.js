import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayerReferralLedger, referralRewardStroops } from '../src/payerReferrals.js';

// Same get/set/setNX/incrBy semantics as store.js's MemoryStore, without
// pulling in config.js (and with it dotenv) just to exercise the ledger.
function fakeStore() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async setNX(key, value) {
      if (map.has(key)) return false;
      map.set(key, value);
      return true;
    },
    async incrBy(key, delta) {
      const next = (map.get(key) || 0) + delta;
      map.set(key, next);
      return next;
    },
  };
}

const WORKER = 'GWORKERREFERRER';
const OTHER_WORKER = 'GOTHERWORKER';
const CODES = {
  'ARB-AAAAAAAA': { code: 'ARB-AAAAAAAA', owner: WORKER },
  'ARB-BBBBBBBB': { code: 'ARB-BBBBBBBB', owner: OTHER_WORKER },
};
const lookupReferralCode = async (code) => CODES[code] ?? null;

function ledger(overrides = {}) {
  const store = fakeStore();
  return { store, ledger: createPayerReferralLedger({ store, lookupReferralCode, rewardBps: 500, now: () => 1_000, ...overrides }) };
}

test('referralRewardStroops takes basis points of the first payment, rounding down', () => {
  assert.equal(referralRewardStroops(10_000_000n, 500), 500_000n);
  assert.equal(referralRewardStroops('10000000', 500), 500_000n);
  assert.equal(referralRewardStroops(3n, 500), 0n);
  assert.equal(referralRewardStroops(10_000_000n, 0), 0n);
  assert.equal(referralRewardStroops('not-a-number', 500), 0n);
  assert.equal(referralRewardStroops(-5n, 500), 0n);
});

test('a first payment with a valid code produces a durable referral credit for the referring worker', async () => {
  const { ledger: l } = ledger();
  const result = await l.recordFirstPaymentReferral({
    payerAddress: 'GPAYER1',
    code: 'ARB-AAAAAAAA',
    questionId: '42',
    amountStroops: 10_000_000n,
    isFirstPayment: true,
  });
  assert.equal(result.recorded, true);
  assert.equal(result.referral.referrer, WORKER);
  assert.equal(result.referral.rewardStroops, '500000');

  const earnings = await l.getWorkerReferralEarnings(WORKER);
  assert.equal(earnings.earnedStroops, 500_000n);
  assert.equal(earnings.referredPayers, 1);
  assert.equal(earnings.referrals[0].payer, 'GPAYER1');
  assert.equal(earnings.referrals[0].questionId, '42');
});

test('attribution is idempotent per payer: a later request cannot overwrite the referrer', async () => {
  const { ledger: l } = ledger();
  await l.recordFirstPaymentReferral({ payerAddress: 'GPAYER2', code: 'ARB-AAAAAAAA', amountStroops: 10_000_000n, isFirstPayment: true });

  // Even claiming to be a first payment, with a different worker's code.
  const second = await l.recordFirstPaymentReferral({ payerAddress: 'GPAYER2', code: 'ARB-BBBBBBBB', amountStroops: 10_000_000n, isFirstPayment: true });
  assert.equal(second.recorded, false);
  assert.equal(second.reason, 'already_attributed');
  assert.equal(second.referral.referrer, WORKER);

  assert.equal((await l.getPayerReferral('GPAYER2')).referrer, WORKER);
  assert.equal((await l.getWorkerReferralEarnings(WORKER)).earnedStroops, 500_000n); // credited once
  assert.equal((await l.getWorkerReferralEarnings(OTHER_WORKER)).earnedStroops, 0n);
});

test('concurrent first payments for the same payer credit the referrer exactly once', async () => {
  const { ledger: l } = ledger();
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      l.recordFirstPaymentReferral({ payerAddress: 'GPAYER3', code: 'ARB-AAAAAAAA', amountStroops: 10_000_000n, isFirstPayment: true }),
    ),
  );
  assert.equal(results.filter((r) => r.recorded).length, 1);
  assert.equal((await l.getWorkerReferralEarnings(WORKER)).earnedStroops, 500_000n);
});

test('a code on a payer who already paid before is not attributed', async () => {
  const { ledger: l } = ledger();
  const result = await l.recordFirstPaymentReferral({ payerAddress: 'GPAYER4', code: 'ARB-AAAAAAAA', amountStroops: 10_000_000n, isFirstPayment: false });
  assert.deepEqual(result, { recorded: false, reason: 'not_first_payment' });
  assert.equal(await l.getPayerReferral('GPAYER4'), null);
});

test('unknown codes and self-referral are refused without throwing', async () => {
  const { ledger: l } = ledger();
  assert.equal((await l.recordFirstPaymentReferral({ payerAddress: 'GPAYER5', code: 'ARB-ZZZZZZZZ', isFirstPayment: true })).reason, 'unknown_code');
  assert.equal((await l.recordFirstPaymentReferral({ payerAddress: WORKER, code: 'ARB-AAAAAAAA', isFirstPayment: true })).reason, 'self_referral');
  assert.equal((await l.recordFirstPaymentReferral({ payerAddress: 'GPAYER5', code: null, isFirstPayment: true })).reason, 'no_code');
  // A refused attempt doesn't burn the payer's one attribution.
  assert.equal((await l.recordFirstPaymentReferral({ payerAddress: 'GPAYER5', code: 'ARB-AAAAAAAA', isFirstPayment: true })).recorded, true);
});

test('disabled ledger records nothing', async () => {
  const { store, ledger: l } = ledger({ enabled: false });
  const result = await l.recordFirstPaymentReferral({ payerAddress: 'GPAYER6', code: 'ARB-AAAAAAAA', isFirstPayment: true });
  assert.deepEqual(result, { recorded: false, reason: 'disabled' });
  assert.equal(store.map.size, 0);
});

test('rewardBps 0 records attribution with no credit', async () => {
  const { ledger: l } = ledger({ rewardBps: 0 });
  const result = await l.recordFirstPaymentReferral({ payerAddress: 'GPAYER7', code: 'ARB-AAAAAAAA', amountStroops: 10_000_000n, isFirstPayment: true });
  assert.equal(result.recorded, true);
  const earnings = await l.getWorkerReferralEarnings(WORKER);
  assert.equal(earnings.earnedStroops, 0n);
  assert.equal(earnings.referredPayers, 1);
});

test('listReferralEarnings lists every referring worker, highest credit first', async () => {
  const { ledger: l } = ledger();
  await l.recordFirstPaymentReferral({ payerAddress: 'GP1', code: 'ARB-BBBBBBBB', amountStroops: 10_000_000n, isFirstPayment: true });
  await l.recordFirstPaymentReferral({ payerAddress: 'GP2', code: 'ARB-AAAAAAAA', amountStroops: 10_000_000n, isFirstPayment: true });
  await l.recordFirstPaymentReferral({ payerAddress: 'GP3', code: 'ARB-AAAAAAAA', amountStroops: 20_000_000n, isFirstPayment: true });

  const rows = await l.listReferralEarnings();
  assert.deepEqual(
    rows.map((r) => [r.worker, r.earnedStroops, r.referredPayers]),
    [
      [WORKER, 1_500_000n, 2],
      [OTHER_WORKER, 500_000n, 1],
    ],
  );
});
