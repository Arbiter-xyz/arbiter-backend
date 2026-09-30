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
  // sid identifies this one session so it can be revoked individually
  // (see revokeSession) without affecting other sessions for the address.
  const sid = randomBytes(12).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ address, exp, sid })).toString('base64url');
  const mac = createHmac('sha256', config.session.secret).update(payload).digest('base64url');
  return { token: `${payload}.${mac}`, expiresAt: exp };
}

/**
 * Returns the set of secrets a session token may currently be verified
 * against: the active SESSION_SECRET, plus the previous one while a
 * rotation grace window is still open. This is what makes rotating
 * SESSION_SECRET graceful — tokens minted under the old secret keep
 * working until the window elapses, instead of every live worker/payer
 * session dying the instant the secret changes.
 *
 * The previous secret is only honored when both it and a positive grace
 * window are configured, and only until `rotatedAt + graceMs`. Once that
 * deadline passes the old secret is dropped entirely, so a leaked key
 * stops being useful after a bounded, operator-controlled period.
 */
function acceptedSessionSecrets(now = Date.now()) {
  const secrets = [config.session.secret];
  const previous = config.session.previousSecret;
  const graceMs = config.session.rotationGraceMs;
  const rotatedAt = config.session.rotatedAt;

  if (previous && previous !== config.session.secret && graceMs > 0) {
    const deadline = (typeof rotatedAt === 'number' ? rotatedAt : 0) + graceMs;
    if (now <= deadline) secrets.push(previous);
  }

  return secrets;
}

/** Constant-time MAC comparison so this can't leak timing information
 * about the secret. */
function macMatches(payload, mac, secret) {
  const expectedMac = createHmac('sha256', secret).update(payload).digest('base64url');
  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expectedMac);
  return macBuf.length === expectedBuf.length && timingSafeEqual(macBuf, expectedBuf);
}

/** Parses and MAC/expiry-checks a token, returning its payload or null. */
function parseSessionToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');

  const validMac = acceptedSessionSecrets().some((secret) => macMatches(payload, mac, secret));
  if (!validMac) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof parsed.exp !== 'number' || Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Returns the authenticated address if `token` is a valid, unexpired
 * session, or null otherwise. Accepts a MAC produced by the current
 * SESSION_SECRET or, during the rotation grace window, the previous one;
 * the payload/expiry checks are identical either way, so tamper and
 * replay resistance are unchanged. Stateless — does NOT check revocation;
 * route handlers must use verifySession() instead. */
export function verifySessionToken(token) {
  return parseSessionToken(token)?.address ?? null;
}

const REVOKED_PREFIX = 'revoked-session:';

/** verifySessionToken() plus a store lookup rejecting revoked sessions.
 * This is what every authenticated route should call. */
export async function verifySession(token) {
  const parsed = parseSessionToken(token);
  if (!parsed) return null;
  if (parsed.sid && (await store.get(REVOKED_PREFIX + parsed.sid))) return null;
  return parsed.address;
}

/** Revokes the session `token` itself, returning the address it was for,
 * or null if the token isn't currently valid (an expired token needs no
 * revocation). The revocation record's TTL matches the token's remaining
 * lifetime, so it never outlives the thing it revokes. Tokens minted
 * before sids existed can't be revoked individually and are rejected. */
export async function revokeSession(token) {
  const parsed = parseSessionToken(token);
  if (!parsed || !parsed.sid) return null;
  if (await store.get(REVOKED_PREFIX + parsed.sid)) return null;
  const remainingMs = parsed.exp - Date.now();
  if (remainingMs <= 0) return null;
  await store.set(REVOKED_PREFIX + parsed.sid, true, remainingMs);
  return parsed.address;
}

/**
 * The single implementation of "prove control of a Stellar address via
 * challenge/response", mounted at both /payers/:address/session* and
 * /workers/:address/session* (the token doesn't distinguish the two —
 * only the route naming does). `middleware` is applied to every route.
 */
export function mountSessionRoutes(app, basePath, ...middleware) {
  app.post(`${basePath}/:address/session/challenge`, ...middleware, async (req, res) => {
    try {
      const xdr = await buildChallengeXdr(req.params.address);
      res.json({ xdr });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post(`${basePath}/:address/session`, ...middleware, async (req, res) => {
    const { signedXdr } = req.body || {};
    if (!signedXdr) return res.status(400).json({ error: 'signedXdr is required' });
    const session = await verifyChallengeAndIssueSession(req.params.address, signedXdr);
    if (!session) return res.status(401).json({ error: 'challenge verification failed — signature did not match, or the challenge expired' });
    res.json(session);
  });

  // Revokes the session making the request — requires the token itself,
  // not just knowledge of the address.
  app.post(`${basePath}/:address/session/revoke`, ...middleware, async (req, res) => {
    const token = req.body?.token;
    if ((await verifySession(token)) !== req.params.address) {
      return res.status(401).json({ error: 'a valid session token for this address is required' });
    }
    await revokeSession(token);
    res.json({ ok: true });
  });
}
