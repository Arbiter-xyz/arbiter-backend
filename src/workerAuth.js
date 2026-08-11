import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { Keypair, Account, TransactionBuilder, Operation, Transaction, StrKey } from '@stellar/stellar-sdk';
import { store } from './store.js';
import { config } from './config.js';

/**
 * Proves a caller actually controls the Stellar address they claim to be
 * before letting them act as it — closing a real gap: POST /app/answer
 * used to take `workerId` straight from the request body with zero
 * verification. A worker's public address is visible on-chain from their
 * own past resolve()/withdraw() transactions, so without this, anyone
 * could impersonate an already-established, trusted worker (worse than a
 * cheap fresh sybil identity — it steals an existing one's credibility)
 * and race to submit a garbage answer under their name, both defrauding
 * consensus and blocking that worker's real answer (one per workerId per
 * question).
 *
 * Deliberately uses signTransaction, not signMessage: signTransaction is
 * the one signing primitive every wallet adapter in this app already
 * implements consistently (it's what onboarding/staking/withdraw all use);
 * signMessage conventions vary enough across wallet implementations that
 * betting a security control on it would trade one gap for a subtler one.
 * The "transaction" here is a throwaway SEP-10-style challenge — a
 * manage_data operation carrying a random nonce, sequence 0, never
 * submitted to the network, used only to produce a verifiable signature.
 *
 * Only enforced for syntactically valid Stellar addresses. An arbitrary
 * test string (the original spec's "no signup, just answer" convenience,
 * still used by worker-sim.js without WORKER_SECRET) can never accumulate
 * real stake or withdrawable earnings anyway — stake()/withdraw() both
 * require a real on-chain signature — so there's no real value to protect
 * behind a non-address id, and demo/testing convenience is preserved.
 */

const CHALLENGE_PREFIX = 'auth-challenge:';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MANAGE_DATA_NAME = 'arbiter-auth';

export function requiresAuth(workerId) {
  return StrKey.isValidEd25519PublicKey(workerId);
}

export async function buildChallengeXdr(workerAddress) {
  if (!StrKey.isValidEd25519PublicKey(workerAddress)) {
    throw new Error('not a valid Stellar address');
  }
  const nonce = randomBytes(32).toString('hex');
  await store.set(CHALLENGE_PREFIX + workerAddress, nonce, CHALLENGE_TTL_MS);

  const account = new Account(workerAddress, '0');
  const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: config.networkPassphrase })
    .addOperation(Operation.manageData({ name: MANAGE_DATA_NAME, value: nonce }))
    .setTimeout(300)
    .build();

  return tx.toXDR();
}

/** Verifies a signed challenge and, on success, issues a bearer session
 * token scoped to that one address. Returns null on any failure — never
 * throws, so callers can respond with a plain 401 without special-casing
 * parse errors vs. verification failures. */
export async function verifyChallengeAndIssueSession(workerAddress, signedXdr) {
  try {
    const expectedNonce = await store.get(CHALLENGE_PREFIX + workerAddress);
    if (!expectedNonce) return null; // no outstanding challenge, or it expired

    const tx = new Transaction(signedXdr, config.networkPassphrase);
    if (tx.operations.length !== 1) return null;

    const op = tx.operations[0];
    if (op.type !== 'manageData' || op.name !== MANAGE_DATA_NAME) return null;
    if (op.value?.toString() !== expectedNonce) return null;

    if (tx.signatures.length !== 1) return null;
    const kp = Keypair.fromPublicKey(workerAddress);
    const valid = kp.verify(tx.hash(), tx.signatures[0].signature());
    if (!valid) return null;

    await store.delete(CHALLENGE_PREFIX + workerAddress); // one-time use — no replay
    return issueSessionToken(workerAddress);
  } catch {
    return null; // malformed XDR, wrong network passphrase, etc. — all just "not authenticated"
  }
}

function issueSessionToken(address) {
  const exp = Date.now() + config.session.ttlMs;
  const payload = Buffer.from(JSON.stringify({ address, exp })).toString('base64url');
  const mac = createHmac('sha256', config.session.secret).update(payload).digest('base64url');
  return { token: `${payload}.${mac}`, expiresAt: exp };
}

/** Returns the authenticated address if `token` is a valid, unexpired
 * session, or null otherwise. Constant-time MAC comparison so this can't
 * leak timing information about the secret. */
export function verifySessionToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  const expectedMac = createHmac('sha256', config.session.secret).update(payload).digest('base64url');

  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expectedMac);
  if (macBuf.length !== expectedBuf.length || !timingSafeEqual(macBuf, expectedBuf)) return null;

  try {
    const { address, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof exp !== 'number' || Date.now() > exp) return null;
    return address;
  } catch {
    return null;
  }
}
