'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  getOrCreateReferralCode,
  redeemReferralCode,
} = require('../src/referrals');

// In-memory store stub matching the shape referrals.js expects.
function makeStore() {
  const codes = new Map();
  const redemptions = new Map();
  return {
    codes,
    redemptions,
    async getCode(code) {
      return codes.get(code) || null;
    },
    async putCode(code, record) {
      codes.set(code, record);
      return record;
    },
    async getRedemptions(code) {
      return redemptions.get(code) || [];
    },
    async addRedemption(code, entry) {
      const list = redemptions.get(code) || [];
      list.push(entry);
      redemptions.set(code, list);
      return entry;
    },
  };
}

test('getOrCreateReferralCode returns existing code for a user', async () => {
  const store = makeStore();
  const first = await getOrCreateReferralCode(store, 'user-1');
  const second = await getOrCreateReferralCode(store, 'user-1');
  assert.strictEqual(first, second);
});

test('getOrCreateReferralCode retries on code collision', async () => {
  const store = makeStore();
  // Pre-seed a code that the generator will collide with first.
  const colliding = 'COLLIDE1';
  await store.putCode(colliding, { code: colliding, ownerId: 'someone-else' });

  let attempts = 0;
  const generator = () => {
    attempts += 1;
    return attempts === 1 ? colliding : 'FRESHCODE';
  };

  const code = await getOrCreateReferralCode(store, 'user-2', { generator });
  assert.strictEqual(code, 'FRESHCODE');
  assert.ok(attempts >= 2, 'should have retried after collision');
  const record = await store.getCode('FRESHCODE');
  assert.strictEqual(record.ownerId, 'user-2');
});

test('redeemReferralCode enforces use cap under concurrency', async () => {
  const store = makeStore();
  const code = 'CAPCODE';
  await store.putCode(code, { code, ownerId: 'owner', maxUses: 1, uses: 0 });

  const results = await Promise.allSettled([
    redeemReferralCode(store, code, 'referee-a'),
    redeemReferralCode(store, code, 'referee-b'),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.strictEqual(fulfilled.length, 1, 'only one redemption should succeed');
  assert.strictEqual(rejected.length, 1, 'the second should be rejected by the cap');
});

test('redeemReferralCode rejects self-referral (owner cannot redeem own code)', async () => {
  const store = makeStore();
  const code = 'SELFCODE';
  await store.putCode(code, { code, ownerId: 'owner', maxUses: 5, uses: 0 });

  await assert.rejects(
    () => redeemReferralCode(store, code, 'owner'),
    /self|own/i,
  );
});

test('redeemReferralCode rejects a referee who already redeemed', async () => {
  const store = makeStore();
  const code = 'DUPCODE';
  await store.putCode(code, { code, ownerId: 'owner', maxUses: 5, uses: 0 });

  await redeemReferralCode(store, code, 'referee-x');
  await assert.rejects(
    () => redeemReferralCode(store, code, 'referee-x'),
    /already/i,
  );
});
