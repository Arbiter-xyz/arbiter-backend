import test from 'node:test';
import assert from 'node:assert/strict';
import { isAnchorConfigured, getAnchorConfig } from '../src/anchorClient.js';
import { recordAnchorTransaction, getAnchorTransactions, recordAnchorKyc, getAnchorKyc } from '../src/anchorRecords.js';
import { listAnchorPayouts, listAnchorKyc } from '../src/admin.js';

function uniqueAddress(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test('isAnchorConfigured is false by default (ANCHOR_HOME_DOMAIN unset, see backend/.env.example)', () => {
  assert.equal(isAnchorConfigured(), false);
});

test('getAnchorConfig rejects within the configured bound when the stellar.toml resolve hangs', async () => {
  const originalHomeDomain = process.env.ANCHOR_HOME_DOMAIN;
  process.env.ANCHOR_HOME_DOMAIN = 'hang.example.com';

  const { StellarToml } = await import('@stellar/stellar-sdk');
  const originalResolve = StellarToml.Resolver.resolve;
  StellarToml.Resolver.resolve = () => new Promise(() => {});

  try {
    const started = Date.now();
    await assert.rejects(
      () => getAnchorConfig(),
      /timed out|timeout/i,
      'a hanging resolve must reject rather than hang forever',
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 30_000, `getAnchorConfig should reject within the configured bound, took ${elapsed}ms`);
  } finally {
    StellarToml.Resolver.resolve = originalResolve;
    if (originalHomeDomain === undefined) {
      delete process.env.ANCHOR_HOME_DOMAIN;
    } else {
      process.env.ANCHOR_HOME_DOMAIN = originalHomeDomain;
    }
  }
});

test('recordAnchorTransaction rejects an unknown kind before writing anything', async () => {
  const address = uniqueAddress('addr');
  await assert.rejects(
    () => recordAnchorTransaction(address, { kind: 'bogus', status: 'x', anchorTransactionId: 'tx1' }),
    /unknown anchor transaction kind/,
  );
  assert.deepEqual(await getAnchorTransactions(address), []);
});

test('recordAnchorTransaction round-trips and de-duplicates by anchorTransactionId (status updates in place)', async () => {
  const address = uniqueAddress('addr');
  await recordAnchorTransaction(address, {
    kind: 'withdrawal',
    status: 'pending_user_transfer_start',
    amount: '10.00',
    assetCode: 'USDC',
    anchorTransactionId: 'tx-abc',
  });
  await recordAnchorTransaction(address, {
    kind: 'withdrawal',
    status: 'completed',
    amount: '10.00',
    assetCode: 'USDC',
    anchorTransactionId: 'tx-abc',
  });

  const txs = await getAnchorTransactions(address);
  assert.equal(txs.length, 1, 'a later report for the same anchor transaction id replaces, not appends');
  assert.equal(txs[0].status, 'completed');
});

test('recordAnchorKyc / getAnchorKyc round trip', async () => {
  const address = uniqueAddress('addr');
  assert.equal(await getAnchorKyc(address), null);

  await recordAnchorKyc(address, { status: 'PENDING', tier: 'basic' });
  assert.deepEqual((await getAnchorKyc(address)).status, 'PENDING');

  await recordAnchorKyc(address, { status: 'ACCEPTED', tier: 'basic' });
  assert.equal((await getAnchorKyc(address)).status, 'ACCEPTED');
});

test('listAnchorPayouts only surfaces withdrawal-kind reports, across all known addresses', async () => {
  const address = uniqueAddress('addr');
  await recordAnchorTransaction(address, { kind: 'deposit', status: 'completed', anchorTransactionId: uniqueAddress('tx') });
  const withdrawalId = uniqueAddress('tx');
  await recordAnchorTransaction(address, { kind: 'withdrawal', status: 'completed', anchorTransactionId: withdrawalId });

  const payouts = await listAnchorPayouts();
  const row = payouts.find((p) => p.anchorTransactionId === withdrawalId);
  assert.ok(row, 'the withdrawal report should appear in listAnchorPayouts');
  assert.equal(row.address, address);
  assert.ok(!payouts.some((p) => p.kind === 'deposit'), 'deposits must never appear in the payouts list');
});

test('listAnchorKyc surfaces the latest reported status per address', async () => {
  const address = uniqueAddress('addr');
  await recordAnchorKyc(address, { status: 'ACCEPTED', tier: 'basic' });

  const customers = await listAnchorKyc();
  const row = customers.find((c) => c.address === address);
  assert.ok(row, 'the KYC report should appear in listAnchorKyc');
  assert.equal(row.status, 'ACCEPTED');
});
