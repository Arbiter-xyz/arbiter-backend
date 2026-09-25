import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import { store } from './store.js';
import { config } from './config.js';
import { hashApiKey } from './apiKeyAuth.js';
import { logger } from './logger.js';

/**
 * The non-crypto onramp: a fiat customer pays via Stripe and is issued an
 * API key instead of ever touching a Stellar wallet. Every fiat-paid
 * question still settles on-chain — from ONE pooled balance under
 * config.billing.fiatPoolAddress, charged via the exact same
 * askMetered()/chargeBalance() path the wallet-based prepaid flow already
 * uses (see metered.js) — this module only handles how a customer gets
 * credit and how much of it they have, never the on-chain settlement
 * itself.
 */

let stripeClient = null;
function getStripe() {
  if (!stripeClient) stripeClient = new Stripe(config.billing.stripeSecretKey);
  return stripeClient;
}

export function isBillingConfigured() {
  return Boolean(config.billing.stripeSecretKey && config.billing.stripeWebhookSecret && config.billing.fiatPoolAddress);
}

function generateAccountId() {
  return `acct_${randomBytes(12).toString('hex')}`;
}

function generateApiKey() {
  return `ak_live_${randomBytes(32).toString('hex')}`;
}

async function createAccount() {
  const accountId = generateAccountId();
  const rawKey = generateApiKey();
  // Durable, no TTL — same as every other identity record in this codebase
  // (worker/payer index entries, reputation).
  await store.set(`account:${accountId}`, { createdAt: Date.now() });
  await store.set(`apikey:${hashApiKey(rawKey)}`, { accountId });
  return { accountId, rawKey };
}

export async function getCreditBalanceStroops(accountId) {
  return (await store.get(`credit:${accountId}`)) || 0;
}

/**
 * Reserves up to `maxStroops` BEFORE the real, possibly-lower surge price
 * is known — askMetered() only reveals the actual price it charged in its
 * return value (amountStroops), by which point the on-chain charge has
 * already happened and can't be undone. Reserving the worst case
 * (tier.priceStroops * MAX_SURGE_MULTIPLIER, see pricing.js) up front, then
 * refunding the difference via settleReservation(), means the ledger can
 * never go negative and a customer can never be charged more than their
 * balance covers, without needing to predict the exact price in advance.
 */
export async function reserveCredit(accountId, maxStroops) {
  return store.decrIfAtLeast(`credit:${accountId}`, maxStroops);
}

/** Credits back the unused portion of a reservation. Pass actualStroops=0
 * to refund the reservation in full (the downstream charge failed
 * entirely — e.g. the pooled on-chain balance itself was insufficient). */
export async function settleReservation(accountId, reservedStroops, actualStroops) {
  const refund = reservedStroops - actualStroops;
  if (refund > 0) await store.incrBy(`credit:${accountId}`, refund);
}

/** Creates a fresh account (and its one API key) and a Stripe Checkout
 * Session to fund it. The raw key is embedded in success_url and shown
 * exactly once on redirect — the same one-time-reveal pattern Stripe
 * itself uses for webhook signing secrets. Losing it means starting over;
 * key recovery/rotation is a deliberate v1 gap, not an oversight.
 *
 * successUrl/cancelUrl are caller-supplied, and the raw key is appended
 * directly to successUrl's query string — without validating the origin,
 * any caller could point successUrl at a domain they control and have
 * Stripe hand a freshly-minted API key straight to them once a real payer
 * completes checkout. Restricted to the same allowlist CORS already
 * enforces (config.allowedOrigins) — a redirect target has to be
 * somewhere this backend already trusts to run frontend code at all. */
/**
 * Puts credit back on an API-key account — used when the customer cancels a
 * question inside the undo window (see oracle.js's cancelJob). The on-chain
 * refund goes to the pooled fiat balance, not to the customer, so without
 * this the pool would be made whole while the customer stayed charged.
 */
export async function restoreCredit(accountId, stroops) {
  if (stroops > 0) await store.incrBy(`credit:${accountId}`, stroops);
}

export function isAllowedRedirectUrl(url) {
  if (config.allowedOrigins.includes('*')) return true; // wide-open dev mode, same default as CORS
  try {
    return config.allowedOrigins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

export async function createCheckoutSession(amountUsd, successUrl, cancelUrl) {
  if (!Number.isFinite(amountUsd) || amountUsd < config.billing.minTopupUsd) {
    throw new Error(`amountUsd must be a number >= ${config.billing.minTopupUsd}`);
  }
  if (!isAllowedRedirectUrl(successUrl) || !isAllowedRedirectUrl(cancelUrl)) {
    throw new Error('successUrl/cancelUrl must be on an allowed origin (see ALLOWED_ORIGINS)');
  }

  const { accountId, rawKey } = await createAccount();
  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: { name: 'Arbiter API credit' },
          unit_amount: Math.round(amountUsd * 100),
        },
        quantity: 1,
      },
    ],
    metadata: { accountId },
    success_url: `${successUrl}?apiKey=${rawKey}`,
    cancel_url: cancelUrl,
  });

  return { checkoutUrl: session.url };
}

/**
 * The single flat subscription tier (issue #101). Prorated upgrades/
 * downgrades between tiers are explicitly out of scope — one tier, one
 * recurring price, one included-volume grant per billing cycle.
 *
 * `includedVolumeStroops` is the credit granted on each `invoice.paid`.
 * `rollover` is the documented policy for unused included volume at the
 * cycle boundary: false means use-it-or-lose-it (the balance is reset to
 * the tier's included volume on renewal, not incremented), true would
 * carry the remainder forward. Defaulting to false mirrors the
 * "0 preserves today's behavior" framing config.js uses for
 * minStakeStroops — the conservative, non-compounding choice is the
 * explicit default, not an accident of implementation order.
 */
export const SUBSCRIPTION_TIER = {
  name: 'api-pro',
  priceUsd: 99,
  includedVolumeStroops: 1_000_000_000,
  rollover: false,
};

/**
 * Creates a fresh account (and its one API key) and a Stripe Checkout
 * Session in `mode: 'subscription'` to fund it. Mirrors
 * createCheckoutSession()'s one-time-reveal pattern for the raw key and
 * its allowed-origin check on the redirect URLs; the difference is the
 * Stripe primitive — a recurring price instead of a one-shot payment, so
 * credit arrives via `invoice.paid` (see handleStripeWebhook) rather than
 * `checkout.session.completed`.
 */
export async function createSubscriptionCheckoutSession(successUrl, cancelUrl) {
  if (!isAllowedRedirectUrl(successUrl) || !isAllowedRedirectUrl(cancelUrl)) {
    throw new Error('successUrl/cancelUrl must be on an allowed origin (see ALLOWED_ORIGINS)');
  }

  const { accountId, rawKey } = await createAccount();
  const session = await getStripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: { name: `Arbiter API ${SUBSCRIPTION_TIER.name}` },
          unit_amount: Math.round(SUBSCRIPTION_TIER.priceUsd * 100),
          recurring: { interval: 'month' },
        },
        quantity: 1,
      },
    ],
    metadata: { accountId },
    success_url: `${successUrl}?apiKey=${rawKey}`,
    cancel_url: cancelUrl,
  });

  return { checkoutUrl: session.url };
}

/**
 * Verifies the Stripe signature (constructEvent throws on a bad/missing
 * one — the route handler turns that into a 400) and, for a completed
 * checkout, credits the account. Idempotent per Stripe event id via
 * store.setNX, since Stripe retries webhook delivery on anything but a 2xx
 * response — without this, a retried delivery would double-credit the same
 * payment.
 *
 * Subscription events use the same per-event-id dedup: recurring invoices
 * legitimately repeat monthly, but each carries a distinct event id, so
 * the 30-day window only suppresses retries of the same delivery — it
 * never swallows a genuine renewal.
 */
export async function handleStripeWebhook(rawBody, signature) {
  const event = getStripe().webhooks.constructEvent(rawBody, signature, config.billing.stripeWebhookSecret);
  if (
    event.type !== 'checkout.session.completed' &&
    event.type !== 'invoice.paid' &&
    event.type !== 'customer.subscription.deleted'
  ) {
    return;
  }

  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const isNew = await store.setNX(`stripe-event:${event.id}`, 1, THIRTY_DAYS_MS);
  if (!isNew) return;

  if (event.type === 'invoice.paid') {
    const invoice = event.data.object;
    const accountId = invoice.subscription_details?.metadata?.accountId || invoice.metadata?.accountId;
    if (!accountId) {
      logger.error({ eventId: event.id }, 'stripe invoice.paid missing accountId metadata');
      return;
    }
    // Use-it-or-lose-it: reset the balance to the tier's included volume
    // rather than incrementing, so unused volume does not compound across
    // cycles. `rollover: true` would instead incrBy the grant.
    if (SUBSCRIPTION_TIER.rollover) {
      await store.incrBy(`credit:${accountId}`, SUBSCRIPTION_TIER.includedVolumeStroops);
    } else {
      await store.set(`credit:${accountId}`, SUBSCRIPTION_TIER.includedVolumeStroops);
    }
    const account = (await store.get(`account:${accountId}`)) || {};
    await store.set(`account:${accountId}`, {
      ...account,
      subscriptionStatus: 'active',
      subscriptionId: invoice.subscription,
    });
    return;
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const accountId = subscription.metadata?.accountId;
    if (!accountId) {
      logger.error({ eventId: event.id }, 'stripe customer.subscription.deleted missing accountId metadata');
      return;
    }
    const account = (await store.get(`account:${accountId}`)) || {};
    await store.set(`account:${accountId}`, { ...account, subscriptionStatus: 'canceled' });
    return;
  }

  const session = event.data.object;
  const accountId = session.metadata?.accountId;
  if (!accountId) {
    logger.error({ eventId: event.id }, 'stripe checkout.session.completed missing accountId metadata');
    return;
  }

  // amount_total is USD cents (integer, no float involved). stroopsPerCent
  // is exact (10_000_000n / 100n = 100_000n) at USDC's 7-decimal
  // convention, so this conversion never loses a fraction of a cent.
  const stroopsPerCent = config.billing.usdToStroops / 100n;
  const amountStroops = BigInt(session.amount_total) * stroopsPerCent;
  await store.incrBy(`credit:${accountId}`, Number(amountStroops));
}

/**
 * Loyalty tiers, keyed off the same aggregate a payer's spend summary
 * already exposes (see payerIndex.js's summarizePayerQuestions()):
 * totalSpendStroops and successRate. Structurally a pure function of an
 * aggregate input, like pricing.js's surgeMultiplier() — no I/O, no
 * store access, trivially unit-testable in isolation.
 *
 * Thresholds are cumulative: a payer at or above a tier's spend/success
 * floor qualifies for that tier, and the highest qualifying tier wins.
 * `bonusStroops` is the one-time credit granted the first time a payer
 * crosses into a tier (see creditLoyaltyBonus below).
 */
export const LOYALTY_TIERS = [
  { name: 'bronze', minSpendStroops: 1_000_000, minSuccessRate: 0.5, bonusStroops: 100_000 },
  { name: 'silver', minSpendStroops: 10_000_000, minSuccessRate: 0.7, bonusStroops: 1_000_000 },
  { name: 'gold', minSpendStroops: 100_000_000, minSuccessRate: 0.9, bonusStroops: 10_000_000 },
];

/**
 * Pure tier evaluation: takes a payer's spend summary (the shape returned
 * by summarizePayerQuestions()) and returns the applicable tier plus its
 * bonus, or null when the payer qualifies for no tier. No side effects —
 * ca

/* … truncated 1304 chars — edit only what you need near the top … */
