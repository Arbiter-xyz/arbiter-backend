import { randomBytes } from 'node:crypto';
import { StrKey } from '@stellar/stellar-sdk';
import { store } from './store.js';
import { config } from './config.js';
import { getReputation } from './dispatch.js';
import { recordReferralLink, isFlaggedPair } from './collusion.js';

/**
 * Referral codes for worker onboarding, tracked entirely by this backend.
 *
 * A worker (a real, session-authenticated Stellar address) mints one code.
 * A new worker redeems it once, as part of POST /workers/:address/onboard,
 * which then hands back the sponsored-onboarding transaction (sponsor.js)
 * so "got a code from a friend" to "has a funded account with a USDC
 * trustline" is one round trip plus one signature.
 *
 * There's no on-chain referral reward: the contract has no such function,
 * and inventing an off-chain payout would be a new money path. What's
 * tracked instead is whether each referral QUALIFIED — the referee became
 * established with a match ratio above the routing gate, and was never
 * flagged by collusion.js alongside their referrer. That's the number worth
 * showing a referrer, and the one any future reward should key off.
 *
 * Anti-abuse, stated plainly:
 *  - One redemption per referee, ever (setNX on the referee key).
 *  - No self-referral, and no redeeming once you have answer history —
 *    referral is an onboarding event, not a label to attach later.
 *  - Per-code use cap (config.referrals.maxUsesPerCode), enforced with an
 *    atomic counter so concurrent redemptions can't overshoot it.
 *  - Every redemption is fed to collusion.js as a referral link, so a
 *    referrer whose referees later vote in lockstep with them scores
 *    higher there.
 *
 * Storage: durable, no TTL (same choice as reputation), with bounded
 * indexes like privatePools.js.
 */

const CODE_PREFIX = 'referral-code:';
const USES_PREFIX = 'referral-uses:';
const OWNER_PREFIX = 'referral-owner:';
const REDEMPTION_PREFIX = 'referral-by:';
const REFEREES_PREFIX = 'referral-referees:';
const REFERRER_INDEX_KEY = 'known-referrers';

const MAX_REFEREES_TRACKED = 1_000;
const MAX_REFERRERS_TRACKED = 5_000;

// Crockford base32: no I, L, O, U — nothing that reads as another
// character when a code is typed from a screenshot or read aloud.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_BODY_LENGTH = 8;
const CODE_PATTERN = /^ARB-[0-9A-HJKMNP-TV-Z]{8}$/;

export class ReferralError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function generateCode() {
  const bytes = randomBytes(CODE_BODY_LENGTH);
  let body = '';
  for (const b of bytes) body += ALPHABET[b % ALPHABET.length]; // 256 % 32 === 0, so no modulo bias
  return `ARB-${body}`;
}

export function normalizeCode(code) {
  if (typeof code !== 'string') return null;
  const upper = code.trim().toUpperCase();
  const withPrefix = upper.startsWith('ARB-') ? upper : `ARB-${upper}`;
  return CODE_PATTERN.test(withPrefix) ? withPrefix : null;
}

async function pushBounded(key, value, max) {
  const list = (await store.get(key)) || [];
  if (list.includes(value)) return;
  await store.set(key, [value, ...list].slice(0, max));
}

async function describeCode(record) {
  const uses = Number(await store.get(USES_PREFIX + record.code)) || 0;
  return { ...record, uses, maxUses: config.referrals.maxUsesPerCode, remaining: Math.max(0, config.referrals.maxUsesPerCode - uses) };
}

export async function getReferralCodeFor(owner) {
  const code = await store.get(OWNER_PREFIX + owner);
  if (!code) return null;
  const record = await store.get(CODE_PREFIX + code);
  return record ? describeCode(record) : null;
}

/**
 * Returns the owner's code, minting one on first call. Idempotent: two
 * concurrent first calls both end up with the same code, since the owner
 * key is claimed with setNX and the loser discards its candidate.
 */
export async function getOrCreateReferralCode(owner) {
  if (!StrKey.isValidEd25519PublicKey(owner)) {
    throw new ReferralError('referral codes can only be minted for a valid Stellar address');
  }
  const existing = await getReferralCodeFor(owner);
  if (existing) return existing;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateCode();
    const record = { code, owner, createdAt: Date.now() };
    if (!(await store.setNX(CODE_PREFIX + code, record))) continue; // code collision, try another

    if (await store.setNX(OWNER_PREFIX + owner, code)) {
      await pushBounded(REFERRER_INDEX_KEY, owner, MAX_REFERRERS_TRACKED);
      return describeCode(record);
    }
    // Lost the race to a concurrent mint for the same owner.
    await store.delete(CODE_PREFIX + code);
    return getReferralCodeFor(owner);
  }
  throw new ReferralError('failed to mint a unique referral code, try again', 503);
}

export async function lookupReferralCode(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const record = await store.get(CODE_PREFIX + normalized);
  return record ? describeCode(record) : null;
}

export async function getReferral(referee) {
  return store.get(REDEMPTION_PREFIX + referee);
}

/**
 * Redeems `code` for `referee`. Idempotent for the same (referee, code) —
 * a retried onboarding call returns the existing redemption rather than
 * failing — but a referee can never switch to a different code.
 */
export async function redeemReferralCode(referee, code) {
  if (!StrKey.isValidEd25519PublicKey(referee)) {
    throw new ReferralError('only a valid Stellar address can redeem a referral code');
  }
  const normalized = normalizeCode(code);
  if (!normalized) throw new ReferralError('malformed referral code');

  const existing = await getReferral(referee);
  if (existing) {
    if (existing.code === normalized) return { ...existing, alreadyRedeemed: true };
    throw new ReferralError('this address has already redeemed a different referral code', 409);
  }

  const record = await store.get(CODE_PREFIX + normalized);
  if (!record) throw new ReferralError('unknown referral code', 404);
  if (record.owner === referee) throw new ReferralError('a worker cannot redeem their own referral code');

  const rep = await getReputation(referee);
  if (rep.total > 0) {
    throw new ReferralError('referral codes are for new workers only — this address already has answer history', 409);
  }

  // Reserve a use first, give it back if anything below fails, so the cap
  // holds under concurrent redemptions of the same code.
  const uses = await store.incrBy(USES_PREFIX + normalized, 1);
  if (uses > config.referrals.maxUsesPerCode) {
    await store.incrBy(USES_PREFIX + normalized, -1);
    throw new ReferralError('this referral code has reached its use limit', 409);
  }

  const redemption = { referee, referrer: record.owner, code: normalized, redeemedAt: Date.now() };
  if (!(await store.setNX(REDEMPTION_PREFIX + referee, redemption))) {
    await store.incrBy(USES_PREFIX + normalized, -1);
    const winner = await getReferral(referee);
    if (winner?.code === normalized) return { ...winner, alreadyRedeemed: true };
    throw new ReferralError('this address has already redeemed a different referral code', 409);
  }

  await pushBounded(REFEREES_PREFIX + record.owner, referee, MAX_REFEREES_TRACKED);
  await recordReferralLink(record.owner, referee);
  return redemption;
}

/**
 * Pure: a referee's status given their reputation and whether collusion.js
 * has flagged them with their referrer.
 *   - 'pending': not established yet (fewer answers than the reputation gate).
 *   - 'qualified': established, and match ratio clears the routing gate.
 *   - 'disqualified': established but under the gate, or flagged with the referrer.
 */
export function referralStatus(rep, flaggedWithReferrer, worker = config.worker) {
  if (flaggedWithReferrer) return 'disqualified';
  if (rep.total < worker.minAnswersBeforeReputationGate) return 'pending';
  return rep.matched / rep.total >= worker.minMatchRatio ? 'qualified' : 'disqualified';
}

/** A referrer's own view: their code plus every referee's progress. */
export async function getReferralSummary(referrer) {
  const code = await getReferralCodeFor(referrer);
  const referees = (await store.get(REFEREES_PREFIX + referrer)) || [];
  const rows = await Promise.all(
    referees.map(async (referee) => {
      const [redemption, rep, flagged] = await Promise.all([
        getReferral(referee),
        getReputation(referee),
        isFlaggedPair(referrer, referee),
      ]);
      return {
        referee,
        redeemedAt: redemption?.redeemedAt ?? null,
        answers: rep.total,
        matchRatio: rep.total > 0 ? rep.matched / rep.total : null,
        status: referralStatus(rep, flagged),
      };
    }),
  );
  const counts = { pending: 0, qualified: 0, disqualified: 0 };
  for (const r of rows) counts[r.status] += 1;
  return { referrer, code, referees: rows, counts };
}

/** Operator view: every referrer with their counts, most qualified first. */
export async function listReferrers() {
  const referrers = (await store.get(REFERRER_INDEX_KEY)) || [];
  const summaries = await Promise.all(referrers.map((r) => getReferralSummary(r)));
  return summaries
    .map(({ referrer, code, referees, counts }) => ({ referrer, code: code?.code ?? null, uses: code?.uses ?? 0, totalReferees: referees.length, ...counts }))
    .sort((a, b) => b.qualified - a.qualified || b.totalReferees - a.totalReferees);
}
