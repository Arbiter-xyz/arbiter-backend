import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, Networks, Transaction, Account, TransactionBuilder, Operation } from '@stellar/stellar-sdk';
import {
  requiresAuth,
  buildChallengeXdr,
  verifyChallengeAndIssueSession,
  verifySessionToken,
} from '../src/workerAuth.js';

test('requiresAuth is true for a real Stellar address, false for an arbitrary test string', () => {
  const worker = Keypair.random();
  assert.equal(requiresAuth(worker.publicKey()), true);
  assert.equal(requiresAuth('demo-worker-1'), false);
  assert.equal(requiresAuth(''), false);
});

test('the full challenge/verify/session round trip succeeds for the real key holder', async () => {
  const worker = Keypair.random();
  const xdr = await buildChallengeXdr(worker.publicKey());

  const tx = new Transaction(xdr, process.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015');
  tx.sign(worker);

  const session = await verifyChallengeAndIssueSession(worker.publicKey(), tx.toXDR());
  assert.ok(session, 'expected a session to be issued');
  assert.ok(session.token);
  assert.ok(session.expiresAt > Date.now());

  const verifiedAddress = verifySessionToken(session.token);
  assert.equal(verifiedAddress, worker.publicKey());
});

test('signing with a DIFFERENT key than the claimed address is rejected', async () => {
  const claimed = Keypair.random();
  const impostor = Keypair.random();
  const xdr = await buildChallengeXdr(claimed.publicKey());

  const tx = new Transaction(xdr, 'Test SDF Network ; September 2015');
  tx.sign(impostor); // signed by the wrong key

  const session = await verifyChallengeAndIssueSession(claimed.publicKey(), tx.toXDR());
  assert.equal(session, null);
});

test('a challenge can only be consumed once (no replay)', async () => {
  const worker = Keypair.random();
  const xdr = await buildChallengeXdr(worker.publicKey());
  const tx = new Transaction(xdr, 'Test SDF Network ; September 2015');
  tx.sign(worker);
  const signedXdr = tx.toXDR();

  const first = await verifyChallengeAndIssueSession(worker.publicKey(), signedXdr);
  assert.ok(first, 'first verification should succeed');

  const second = await verifyChallengeAndIssueSession(worker.publicKey(), signedXdr);
  assert.equal(second, null, 'replaying the same signed challenge must be rejected');
});

test('signing a DIFFERENT nonce than the one issued is rejected (prevents reusing an old/foreign challenge)', async () => {
  const worker = Keypair.random();
  await buildChallengeXdr(worker.publicKey()); // issue and discard a real challenge

  // Hand-craft a transaction with a bogus nonce instead of the real one.
  const account = new Account(worker.publicKey(), '0');
  const forged = new TransactionBuilder(account, { fee: '100', networkPassphrase: 'Test SDF Network ; September 2015' })
    .addOperation(Operation.manageData({ name: 'arbiter-auth', value: 'not-the-real-nonce' }))
    .setTimeout(300)
    .build();
  forged.sign(worker);

  const session = await verifyChallengeAndIssueSession(worker.publicKey(), forged.toXDR());
  assert.equal(session, null);
});

test('verifying a session token for one address never validates for a different address', async () => {
  const worker = Keypair.random();
  const xdr = await buildChallengeXdr(worker.publicKey());
  const tx = new Transaction(xdr, 'Test SDF Network ; September 2015');
  tx.sign(worker);
  const { token } = await verifyChallengeAndIssueSession(worker.publicKey(), tx.toXDR());

  const someoneElse = Keypair.random().publicKey();
  assert.notEqual(verifySessionToken(token), someoneElse);
  assert.equal(verifySessionToken(token), worker.publicKey());
});

test('a tampered token (flipped character in the MAC) is rejected', async () => {
  const worker = Keypair.random();
  const xdr = await buildChallengeXdr(worker.publicKey());
  const tx = new Transaction(xdr, 'Test SDF Network ; September 2015');
  tx.sign(worker);
  const { token } = await verifyChallengeAndIssueSession(worker.publicKey(), tx.toXDR());

  const tampered = token.slice(0, -1) + (token.at(-1) === 'a' ? 'b' : 'a');
  assert.equal(verifySessionToken(tampered), null);
});

test('a garbage token never throws, just fails verification', () => {
  assert.equal(verifySessionToken('not-a-real-token'), null);
  assert.equal(verifySessionToken(''), null);
  assert.equal(verifySessionToken(undefined), null);
  assert.equal(verifySessionToken('a.b.c'), null);
});

test('verifying with a bogus challenge address (no outstanding challenge) fails cleanly', async () => {
  const worker = Keypair.random();
  const session = await verifyChallengeAndIssueSession(worker.publicKey(), 'not-valid-xdr-at-all');
  assert.equal(session, null);
});

test('buildChallengeXdr rejects a non-address input rather than building a meaningless challenge', async () => {
  await assert.rejects(() => buildChallengeXdr('not-an-address'));
});
