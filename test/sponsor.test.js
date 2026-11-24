import './helpers/sponsor-test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, TransactionBuilder, Contract, Account, Address, nativeToScVal, Networks } from '@stellar/stellar-sdk';
import { feeBumpStake, feeBumpWithdraw, feeBumpSubmitPayment, buildSponsoredOnboardTx } from '../src/sponsor.js';
import { config } from '../src/config.js';
import * as sponsorModule from '../src/sponsor.js';

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

test('buildSponsoredOnboardTx rejects a malformed address with a validation error', async () => {
  await assert.rejects(() => buildSponsoredOnboardTx('not-a-valid-address'), (err) => {
    assert.match(err.message, /invalid/i);
    assert.match(err.message, /address/i);
    return true;
  });
});

test('buildSponsoredOnboardTx rejects a malformed address without consuming the onboarding rate limit', async () => {
  const valid = Keypair.random().publicKey();

  // Burn through the per-address limit with malformed addresses that share no key with `valid`.
  for (let i = 0; i < 10; i += 1) {
    await assert.rejects(() => buildSponsoredOnboardTx(`garbage-${i}`), /invalid/i);
  }

  // A valid address must still be allowed through the rate limiter (it fails later on
  // unconfigured Horizon/admin, not on the rate limit).
  await assert.rejects(() => buildSponsoredOnboardTx(valid), (err) => {
    assert.doesNotMatch(err.message, /too many sponsored-onboard requests/);
    return true;
  });
});

test('buildSponsoredOnboardTx proceeds past validation for a valid address', async () => {
  const valid = Keypair.random().publicKey();

  await assert.rejects(() => buildSponsoredOnboardTx(valid), (err) => {
    // Must not be a validation error; failure comes from unconfigured admin/Horizon.
    assert.doesNotMatch(err.message, /invalid/i);
    return true;
  });
});

test('the per-address onboarding limit is still enforced after 3 attempts in the window', async () => {
  const valid = Keypair.random().publicKey();

  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(() => buildSponsoredOnboardTx(valid), (err) => {
      assert.doesNotMatch(err.message, /too many sponsored-onboard requests/);
      return true;
    });
  }

  await assert.rejects(() => buildSponsoredOnboardTx(valid), (err) => {
    assert.match(err.message, /too many sponsored-onboard requests/);
    return true;
  });
});

test('sponsor.js no longer keeps an in-process onboardAttempts map', () => {
  assert.equal(sponsorModule.onboardAttempts, undefined);
});
