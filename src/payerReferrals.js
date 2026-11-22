/**
 * Payer referrals (#99): a worker who brings in a new payer gets that payer
 * attributed to them, plus a one-time referral credit.
 *
 * Reuses referrals.js's code primitive rather than minting a second kind of
 * code: the worker shares the same ARB-XXXXXXXX code they already use for
 * worker onboarding, and a payer passes it on POST /oracle. Attribution
 * happens at the payer's first verified payment, the same moment
 * payerIndex.js starts tracking them, because before that point the payer
 * is anonymous and nothing has been paid to attribute.
 *
 * Rules, stated plainly:
 *  - First touch only. A payer is attributed once, ever, claimed with setNX
 *    on the payer key, so a later request can't overwrite the referrer.
 *  - Only on the first payment. A payer who already paid without a code
 *    can't attach one afterwards — referral is an acquisition event, the
 *    same stance referrals.js takes for workers with answer history.
 *  - No self-referral: a worker paying with their own code gets nothing.
 *
 * The credit is informational bookkeeping, like payerIndex.js's spend
 * tracking: a durable incrBy counter of stroops per worker, which the admin
 * console lists. Nothing here moves money. If credits are ever paid out,
 * that's a new money path (an on-chain Owed-style balance or an off-chain
 * transfer) and a separate design decision, out of scope for this module.
 *
 * Built as a factory over an injected store and code lookup so it carries no
 * config/SDK imports and is testable on its own. The ledger is stateless
 * beyond the store, so oracle.js (writes, primary store) and admin.js
 * (reads, replica-aware store) each build their own instance.
 */

const PAYER_REFERRER_PREFIX = 'payer-referrer:';
const EARNINGS_PREFIX = 'payer-referral-earnings:';
const REFERRED_PAYERS_PREFIX = 'payer-referral-payers:';
const REFERRER_INDEX_KEY = 'known-payer-referrers';

const MAX_PAYERS_TRACKED = 1_000;
const MAX_REFERRERS_TRACKED = 5_000;
const BPS_DENOM = 10_000n;

/** Pure: the one-time credit for a first payment of `amountStroops`. */
export function referralRewardStroops(amountStroops, rewardBps) {
  let amount;
  try {
    amount = BigInt(amountStroops ?? 0);
  } catch {
    return 0n;
  }
  const bps = BigInt(Math.max(0, Math.floor(Number(rewardBps) || 0)));
  if (amount <= 0n || bps === 0n) return 0n;
  return (amount * bps) / BPS_DENOM;
}

export function createPayerReferralLedger({ store, lookupReferralCode, rewardBps = 0, enabled = true, now = Date.now } = {}) {
  if (!store) throw new Error('createPayerReferralLedger: store is required');

  async function pushBounded(key, value, max) {
    const list = (await store.get(key)) || [];
    if (list.includes(value)) return;
    await store.set(key, [value, ...list].slice(0, max));
  }

  async function getPayerReferral(payerAddress) {
    if (!payerAddress) return null;
    return store.get(PAYER_REFERRER_PREFIX + payerAddress);
  }

  /**
   * Attributes `payerAddress` to the owner of `code` if, and only if, this is
   * the payer's first verified payment and they have no referrer yet.
   * Returns `{ recorded: true, referral }` or `{ recorded: false, reason }`
   * (plus the existing `referral` when one is already on file). Never
   * throws for a bad code: the payment has already landed, and a referral
   * problem must not turn into a payment problem.
   */
  async function recordFirstPaymentReferral({ payerAddress, code, questionId = null, amountStroops = 0, isFirstPayment }) {
    if (!enabled) return { recorded: false, reason: 'disabled' };
    if (!payerAddress || !code) return { recorded: false, reason: 'no_code' };

    const existing = await getPayerReferral(payerAddress);
    if (existing) return { recorded: false, reason: 'already_attributed', referral: existing };
    if (!isFirstPayment) return { recorded: false, reason: 'not_first_payment' };

    const codeRecord = lookupReferralCode ? await lookupReferralCode(code) : null;
    if (!codeRecord?.owner) return { recorded: false, reason: 'unknown_code' };
    if (codeRecord.owner === payerAddress) return { recorded: false, reason: 'self_referral' };

    const reward = referralRewardStroops(amountStroops, rewardBps);
    const referral = {
      payer: payerAddress,
      referrer: codeRecord.owner,
      code: codeRecord.code,
      questionId,
      firstPaymentStroops: String(amountStroops ?? 0),
      rewardStroops: reward.toString(),
      attributedAt: now(),
    };

    // The setNX is the idempotency guarantee: of two concurrent first
    // payments, exactly one writes the referral and credits the referrer.
    if (!(await store.setNX(PAYER_REFERRER_PREFIX + payerAddress, referral))) {
      return { recorded: false, reason: 'already_attributed', referral: await getPayerReferral(payerAddress) };
    }

    if (reward > 0n) await store.incrBy(EARNINGS_PREFIX + referral.referrer, Number(reward));
    await pushBounded(REFERRED_PAYERS_PREFIX + referral.referrer, payerAddress, MAX_PAYERS_TRACKED);
    await pushBounded(REFERRER_INDEX_KEY, referral.referrer, MAX_REFERRERS_TRACKED);
    return { recorded: true, referral };
  }

  /** One worker's referral credit plus every payer attributed to them. */
  async function getWorkerReferralEarnings(worker) {
    const [earned, payers] = await Promise.all([
      store.get(EARNINGS_PREFIX + worker),
      store.get(REFERRED_PAYERS_PREFIX + worker),
    ]);
    const referrals = (await Promise.all((payers || []).map((p) => getPayerReferral(p)))).filter(Boolean);
    return {
      worker,
      earnedStroops: BigInt(Math.trunc(Number(earned) || 0)),
      referredPayers: referrals.length,
      referrals,
    };
  }

  /** Every worker with at least one referred payer, highest credit first. */
  async function listReferralEarnings() {
    const workers = (await store.get(REFERRER_INDEX_KEY)) || [];
    const rows = await Promise.all(workers.map((w) => getWorkerReferralEarnings(w)));
    return rows.sort((a, b) =>
      b.earnedStroops > a.earnedStroops ? 1 : b.earnedStroops < a.earnedStroops ? -1 : b.referredPayers - a.referredPayers,
    );
  }

  return Object.freeze({ getPayerReferral, recordFirstPaymentReferral, getWorkerReferralEarnings, listReferralEarnings });
}
