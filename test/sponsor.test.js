import './helpers/sponsor-test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, TransactionBuilder, Contract, Account, Address, nativeToScVal, Networks } from '@stellar/stellar-sdk';
import {
  feeBumpStake,
  feeBumpWithdraw,
  feeBumpSubmitPayment,
  feeBumpWithdrawTo,
  buildSponsoredOnboardTx,
} from '../src/sponsor.js';
import { config } from '../src/config.js';
import { getHorizon } from '../src/horizon.js';

function addressArg(addr) {
  return new Address(addr).toScVal();
}

function buildSignedTx(functionName, args) {
  const kp = Keypair.random();
  const account = new Account(kp.publicKey(), '1');
  const contract = new Contract(config.contractId);
  const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(contract.call(functionName, ...args))
    .setTimeout(30)
    .build();
  tx.sign(kp);
  return tx.toXDR();
}

test('a correctly-shaped stake() call passes the security check (fails later only on missing PLATFORM_SECRET)', async () => {
  const worker = Keypair.random().publicKey();
  const xdr = buildSignedTx('stake', [addressArg(worker), nativeToScVal(500_000n, { type: 'i128' })]);

  await assert.rejects(() => feeBumpStake(xdr, worker, 500_000n), (err) => {
    // Must fail on the admin keypair being unconfigured, NOT on the security check.
    assert.match(err.message, /PLATFORM_SECRET/);
    return true;
  });
});

test('a wrong function name is rejected by the security check before touching any admin key', async () => {
  const worker = Keypair.random().publicKey();
  const xdr = buildSignedTx('unstake', [addressArg(worker), nativeToScVal(500_000n, { type: 'i128' })]);

  await assert.rejects(() => feeBumpStake(xdr, worker, 500_000n), (err) => {
    assert.match(err.message, /does not match the expected stake\(\) call/);
    return true;
  });
});

test('a mismatched amount is rejected by the security check', async () => {
  const worker = Keypair.random().publicKey();
  const xdr = buildSignedTx('stake', [addressArg(worker), nativeToScVal(1n, { type: 'i128' })]);

  await assert.rejects(() => feeBumpStake(xdr, worker, 999_999n), (err) => {
    assert.match(err.message, /does not match the expected stake\(\) call/);
    return true;
  });
});

test('a transaction with more than one operation is rejected regardless of content', async () => {
  const worker = Keypair.random().publicKey();
  const kp = Keypair.random();
  const account = new Account(kp.publicKey(), '1');
  const contract = new Contract(config.contractId);
  const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(contract.call('withdraw', addressArg(worker), nativeToScVal(500_000n, { type: 'i128' })))
    .addOperation(contract.call('withdraw', addressArg(worker), nativeToScVal(500_000n, { type: 'i128' })))
    .setTimeout(30)
    .build();
  tx.sign(kp);

  await assert.rejects(() => feeBumpWithdraw(tx.toXDR(), worker, 500_000n), (err) => {
    assert.match(err.message, /expected exactly one operation/);
    return true;
  });
});

test('withdraw() for a DIFFERENT worker than claimed is rejected (prevents spoofing whose payout is fee-bumped)', async () => {
  const actualWorker = Keypair.random().publicKey();
  const claimedWorker = Keypair.random().publicKey();
  const xdr = buildSignedTx('withdraw', [addressArg(actualWorker), nativeToScVal(500_000n, { type: 'i128' })]);

  await assert.rejects(() => feeBumpWithdraw(xdr, claimedWorker, 500_000n), (err) => {
    assert.match(err.message, /does not match the expected withdraw\(\) call/);
    return true;
  });
});

test('withdraw() with a mismatched amount is rejected', async () => {
  const worker = Keypair.random().publicKey();
  const xdr = buildSignedTx('withdraw', [addressArg(worker), nativeToScVal(1n, { type: 'i128' })]);

  await assert.rejects(() => feeBumpWithdraw(xdr, worker, 999_999n), (err) => {
    assert.match(err.message, /does not match the expected withdraw\(\) call/);
    return true;
  });
});

test('submit() with a tampered amount is rejected (regression check for the original fee-relay guard)', async () => {
  const payer = Keypair.random().publicKey();
  const xdr = buildSignedTx('submit', [addressArg(payer), nativeToScVal(1n, { type: 'u64' }), nativeToScVal(1n, { type: 'i128' })]);

  await assert.rejects(() => feeBumpSubmitPayment(xdr, payer, 1n, 999_999n), (err) => {
    assert.match(err.message, /does not match the expected submit\(\) call/);
    return true;
  });
});

function stubLoadAccount() {
  const platform = Keypair.random();
  const original = getHorizon().loadAccount;
  getHorizon().loadAccount = async (publicKey) => new Account(publicKey, '1');
  return {
    platform,
    restore() {
      getHorizon().loadAccount = original;
    },
  };
}

test('buildSponsoredOnboardTx() builds exactly beginSponsoring, createAccount, changeTrust, endSponsoring with the right sources', async () => {
  const stub = stubLoadAccount();
  try {
    const worker = Keypair.random().publicKey();
    const xdr = await buildSponsoredOnboardTx(worker);
    const tx = TransactionBuilder.fromXDR(xdr, config.networkPassphrase);
    const ops = tx.operations;

    assert.equal(ops.length, 4);
    assert.equal(ops[0].type, 'beginSponsoringFutureReserves');
    assert.equal(ops[0].sponsoredId, worker);
    assert.equal(ops[1].type, 'createAccount');
    assert.equal(ops[1].destination, worker);
    assert.equal(ops[1].startingBalance, '0');
    assert.equal(ops[2].type, 'changeTrust');
    assert.equal(ops[3].type, 'endSponsoringFutureReserves');

    // changeTrust and endSponsoringFutureReserves must be sourced from the worker;
    // the others from the platform account.
    assert.equal(ops[2].source, worker);
    assert.equal(ops[3].source, worker);
    assert.equal(ops[0].source, undefined);
    assert.equal(ops[1].source, undefined);
  } finally {
    stub.restore();
  }
});

test('buildSponsoredOnboardTx() enforces the per-address rate limit on the 4th call within a minute', async () => {
  const stub = stubLoadAccount();
  try {
    const worker = Keypair.random().publicKey();
    await buildSponsoredOnboardTx(worker);
    await buildSponsoredOnboardTx(worker);
    await buildSponsoredOnboardTx(worker);

    await assert.rejects(() => buildSponsoredOnboardTx(worker), (err) => {
      assert.match(err.message, /rate limit/i);
      return true;
    });
  } finally {
    stub.restore();
  }
});

test('feeBumpWithdrawTo() rejects an inner tx that calls withdraw instead of withdraw_to', async () => {
  const worker = Keypair.random().publicKey();
  const beneficiary = Keypair.random().publicKey();
  const xdr = buildSignedTx('withdraw', [addressArg(worker), nativeToScVal(500_000n, { type: 'i128' })]);

  await assert.rejects(() => feeBumpWithdrawTo(xdr, worker, beneficiary, 500_000n), (err) => {
    assert.match(err.message, /does not match the expected withdraw_to\(\) call/);
    return true;
  });
});

test('feeBumpWithdrawTo() rejects an inner tx whose beneficiary differs from the claimed beneficiary', async () => {
  const worker = Keypair.random().publicKey();
  const actualBeneficiary = Keypair.random().publicKey();
  const claimedBeneficiary = Keypair.random().publicKey();
  const xdr = buildSignedTx('withdraw_to', [
    addressArg(worker),
    addressArg(actualBeneficiary),
    nativeToScVal(500_000n, { type: 'i128' }),
  ]);

  await assert.rejects(() => feeBumpWithdrawTo(xdr, worker, claimedBeneficiary, 500_000n), (err) => {
    assert.match(err.message, /does not match the expected withdraw_to\(\) call/);
    return true;
  });
});
