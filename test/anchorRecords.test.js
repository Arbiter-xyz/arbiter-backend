import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../src/store.js';
import {
  getKnownAnchorAddresses,
  recordAnchorTransaction,
  getAnchorTransactions,
  recordAnchorKyc,
  getAnchorKyc,
  eraseAnchorRecords,
} from '../src/anchorRecords.js';

test('recordAnchorTransaction validates kind, deduplicates by anchorTransactionId, and bounds history to 50', async () => {
  const addr = 'GANCHORTEST111111111111111111111111111111111111111111111';
  const prevKnown = await store.get('known-anchor-addresses');

  try {
    await assert.rejects(
      () => recordAnchorTransaction(addr, { kind: 'swap', status: 'completed', amount: '10', assetCode: 'USDC' }),
      /unknown anchor transaction kind: swap/,
    );

    await recordAnchorTransaction(addr, {
      kind: 'deposit',
      status: 'pending_user_transfer_start',
      amount: '100',
      assetCode: 'USDC',
      anchorTransactionId: 'sep24-tx-1',
    });
    await recordAnchorTransaction(addr, {
      kind: 'withdrawal',
      status: 'incomplete',
      amount: '40',
      assetCode: 'USDC',
      anchorTransactionId: 'sep24-tx-2',
    });
    // Updating sep24-tx-1 replaces the earlier record and moves it to the front
    await recordAnchorTransaction(addr, {
      kind: 'deposit',
      status: 'completed',
      amount: '100',
      assetCode: 'USDC',
      anchorTransactionId: 'sep24-tx-1',
    });

    const txs = await getAnchorTransactions(addr);
    assert.equal(txs.length, 2);
    assert.equal(txs[0].anchorTransactionId, 'sep24-tx-1');
    assert.equal(txs[0].status, 'completed');
    assert.equal(txs[1].anchorTransactionId, 'sep24-tx-2');

    // Transactions without anchorTransactionId do not overwrite one another
    await recordAnchorTransaction(addr, { kind: 'deposit', status: 'completed', amount: '5', assetCode: 'USDC' });
    await recordAnchorTransaction(addr, { kind: 'deposit', status: 'completed', amount: '6', assetCode: 'USDC' });
    const withUnkeyed = await getAnchorTransactions(addr);
    assert.equal(withUnkeyed.length, 4);

    // Cap at 50 records per address
    for (let i = 0; i < 60; i++) {
      await recordAnchorTransaction(addr, {
        kind: 'deposit',
        status: 'completed',
        amount: String(i),
        assetCode: 'USDC',
        anchorTransactionId: `bulk-${i}`,
      });
    }
    const capped = await getAnchorTransactions(addr);
    assert.equal(capped.length, 50);
    assert.equal(capped[0].anchorTransactionId, 'bulk-59');
  } finally {
    await eraseAnchorRecords(addr);
    if (prevKnown === null) await store.delete('known-anchor-addresses');
    else await store.set('known-anchor-addresses', prevKnown);
  }
});

test('recordAnchorKyc, getKnownAnchorAddresses, and eraseAnchorRecords manage and scrub per-address records', async () => {
  const addr1 = 'GANCHORERASURE111111111111111111111111111111111111111111';
  const addr2 = 'GANCHORERASURE222222222222222222222222222222222222222222';
  const prevKnown = await store.get('known-anchor-addresses');

  try {
    await store.delete('known-anchor-addresses');
    await recordAnchorTransaction(addr1, {
      kind: 'deposit',
      status: 'completed',
      amount: '250',
      assetCode: 'USDC',
      anchorTransactionId: 'tx-erase-1',
    });
    await recordAnchorKyc(addr1, { status: 'approved', tier: 'tier_2' });
    await recordAnchorKyc(addr2, { status: 'pending', tier: 'tier_1' });

    const knownBefore = await getKnownAnchorAddresses();
    assert.ok(knownBefore.includes(addr1));
    assert.ok(knownBefore.includes(addr2));

    const kyc1 = await getAnchorKyc(addr1);
    assert.equal(kyc1.status, 'approved');
    assert.equal(kyc1.tier, 'tier_2');

    // GDPR/CCPA erasure removes transactions, KYC, and the address index entry for addr1 only
    await eraseAnchorRecords(addr1);

    assert.deepEqual(await getAnchorTransactions(addr1), []);
    assert.equal(await getAnchorKyc(addr1), null);
    const knownAfter = await getKnownAnchorAddresses();
    assert.equal(knownAfter.includes(addr1), false);
    assert.equal(knownAfter.includes(addr2), true);
    assert.equal((await getAnchorKyc(addr2)).status, 'pending');
  } finally {
    await eraseAnchorRecords(addr1);
    await eraseAnchorRecords(addr2);
    if (prevKnown === null) await store.delete('known-anchor-addresses');
    else await store.set('known-anchor-addresses', prevKnown);
  }
});
