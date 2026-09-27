import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import { store } from './store.js';
import { config } from './config.js';
import { hashApiKey } from './apiKeyAuth.js';
import { logger } from './logger.js';
import { recordPaymentReversal } from './paymentReversals.js';

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
  await store.set(`account-key:${accountId}`, hashApiKey(rawKey));
  return { accountId, rawKey };
}

/**
 * Swaps an account's API key for a fresh one. The caller must already
 * hold the current key (resolved by the route via resolveApiKey()); the
 * old key's apikey:{hash} entry is deleted before returning, so it stops
 * working immediately — no grace period. Credit balance and history are
 * keyed by accountId and are untouched.
 */
export async function rotateApiKey(accountId, currentRawKey) {
  const rawKey = generateApiKey();
  const newHash = hashApiKey(rawKey);
  await store.set(`apikey:${newHash}`, { accountId });
  await store.delete(`apikey:${hashApiKey(currentRawKey)}`);
  await store.set(`account-key:${accountId}`, newHash);
  return rawKey;
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
 * proactive rotation (with the current key in hand) is available via
 * rotateApiKey(); recovery of a lost key is a deliberate v1 gap.
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
 * Verifies the Stripe signature (constructEvent throws on a bad/missing
 * one — the route handler turns that into a 400) and, for a completed
 * checkout, credits the account; for a refund/dispute, debits it (see
 * reverseCharge). Every other event type is ignored. Idempotent per Stripe event id via
 * store.setNX, since Stripe retries webhook delivery on anything but a 2xx
 * response — without this, a retried delivery would double-credit the same
 * payment.
 */
export async function handleStripeWebhook(rawBody, signature) {
  const event = getStripe().webhooks.constructEvent(rawBody, signature, config.billing.stripeWebhookSecret);
  if (!HANDLED_EVENT_TYPES.has(event.type)) return;

  const isNew = await store.setNX(`stripe-event:${event.id}`, 1, THIRTY_DAYS_MS);
  if (!isNew) return;

  if (event.type === 'checkout.session.completed') return creditCheckout(event);
  return reverseCharge(event);
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const HANDLED_EVENT_TYPES = new Set(['checkout.session.completed', 'charge.refunded', 'charge.dispute.created']);

// amount_total is USD cents (integer, no float involved). stroopsPerCent
// is exact (10_000_000n / 100n = 100_000n) at USDC's 7-decimal
// convention, so this conversion never loses a fraction of a cent.
function centsToStroops(cents) {
  return Number(BigInt(cents) * (config.billing.usdToStroops / 100n));
}

async function creditCheckout(event) {
  const session = event.data.object;
  const accountId = session.metadata?.accountId;
  if (!accountId) {
    logger.error({ eventId: event.id }, 'stripe checkout.session.completed missing accountId metadata');
    return;
  }
  // Durable paymentIntent -> account mapping, so a later refund/dispute
  // (which carries only the PaymentIntent, not our checkout metadata) can
  // be correlated back to the account it credited.
  if (session.payment_intent) {
    await store.set(`stripe-pi:${session.payment_intent}`, { accountId, amountCents: session.amount_total });
  }
  await store.incrBy(`credit:${accountId}`, centsToStroops(session.amount_total));
}

/**
 * Claws back credit for a refunded or disputed charge. The balance is
 * floored at 0, never negative — it may already be partially or fully
 * spent (settled on-chain out of the fiat pool), and that is an explicit
 * policy choice: the shortfall is recorded for the admin console
 * (/admin/reversals) rather than carried as debt on the account.
 */
async function reverseCharge(event) {
  const obj = event.data.object;
  const mapping = obj.payment_intent ? await store.get(`stripe-pi:${obj.payment_intent}`) : null;
  const accountId = mapping?.accountId || obj.metadata?.accountId;
  if (!accountId) {
    logger.error({ eventId: event.id, type: event.type }, 'stripe reversal could not be correlated to an account');
    return;
  }

  // charge.refunded carries the cumulative amount_refunded on the charge;
  // charge.dispute.created carries the disputed amount.
  const amountCents = event.type === 'charge.refunded' ? obj.amount_refunded : obj.amount;
  const requestedStroops = centsToStroops(amountCents || 0);
  const debitedStroops = await debitCreditFloored(accountId, requestedStroops);

  await recordPaymentReversal(accountId, {
    eventId: event.id,
    type: event.type,
    paymentIntent: obj.payment_intent || null,
    amountCents: amountCents || 0,
    requestedStroops: String(requestedStroops),
    debitedStroops: String(debitedStroops),
    shortfallStroops: String(requestedStroops - debitedStroops),
  });
  logger.warn({ accountId, eventId: event.id, type: event.type, requestedStroops, debitedStroops }, 'stripe payment reversed — credit debited');
}

/** Debits up to `stroops` from an account, never below 0. Retries around
 * concurrent spends via the atomic decrIfAtLeast. Returns the amount
 * actually debited. */
async function debitCreditFloored(accountId, stroops) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const balance = await getCreditBalanceStroops(accountId);
    const take = Math.min(balance, stroops);
    if (take <= 0) return 0;
    if (await store.decrIfAtLeast(`credit:${accountId}`, take)) return take;
  }
  return 0;
}
