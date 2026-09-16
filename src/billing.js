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
 * key recovery/rotation is a deliberate v1 gap, not an oversight. */
export async function createCheckoutSession(amountUsd, successUrl, cancelUrl) {
  if (!Number.isFinite(amountUsd) || amountUsd < config.billing.minTopupUsd) {
    throw new Error(`amountUsd must be a number >= ${config.billing.minTopupUsd}`);
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
 * Verifies the Stripe signature (constructEvent throws on a bad/missing
 * one — the route handler turns that into a 400) and, for a completed
 * checkout, credits the account. Idempotent per Stripe event id via
 * store.setNX, since Stripe retries webhook delivery on anything but a 2xx
 * response — without this, a retried delivery would double-credit the same
 * payment.
 */
export async function handleStripeWebhook(rawBody, signature) {
  const event = getStripe().webhooks.constructEvent(rawBody, signature, config.billing.stripeWebhookSecret);
  if (event.type !== 'checkout.session.completed') return;

  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const isNew = await store.setNX(`stripe-event:${event.id}`, 1, THIRTY_DAYS_MS);
  if (!isNew) return;

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
