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

/**
 * Supported fiat currencies for the Stripe onramp, each with the number of
 * minor units Stripe expects in `unit_amount` (USD/EUR cents, JPY has none)
 * and the FX rate to USDC face value. Rates are a periodically-updated
 * static table rather than a live lookup: the issue explicitly allows this
 * when precision-to-the-cent isn't required, and it keeps the webhook path
 * free of an external dependency that could be unreachable at credit time.
 * `usdToStroops` remains the USD anchor (config.billing.usdToStroops) so
 * the existing 1:1 USD conversion is unchanged.
 */
const SUPPORTED_CURRENCIES = {
  usd: { minorUnits: 100, usdPerUnit: 1 },
  eur: { minorUnits: 100, usdPerUnit: 1.08 },
  gbp: { minorUnits: 100, usdPerUnit: 1.27 },
};

/**
 * Resolves a currency code to its FX descriptor, or throws for an
 * unsupported/malformed code. Callers turn the throw into a 400 — an
 * unknown currency must never silently fall back to USD.
 */
export function resolveCurrency(currency) {
  if (typeof currency !== 'string') {
    throw new Error('currency must be a string');
  }
  const code = currency.trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(code) || !SUPPORTED_CURRENCIES[code]) {
    throw new Error(`unsupported currency: ${currency}`);
  }
  return { code, ...SUPPORTED_CURRENCIES[code] };
}

/**
 * Converts a fiat amount (in the currency's major unit) to stroops of USDC
 * face value, using the currency's FX rate. The rate is resolved once at
 * checkout time and snapshotted into the Stripe session metadata so the
 * webhook credits at exactly the rate the customer saw — mirroring how
 * pricing.js's priceForTier() snapshots a surge-adjusted price at quote
 * time so it can't move under the payer before settlement.
 */
function fiatToStroops(amount, currency) {
  const { usdPerUnit } = resolveCurrency(currency);
  const usd = amount * usdPerUnit;
  return BigInt(Math.round(usd * Number(config.billing.usdToStroops)));
}

export async function createCheckoutSession(amountUsd, successUrl, cancelUrl, currency = 'usd') {
  if (!Number.isFinite(amountUsd) || amountUsd < config.billing.minTopupUsd) {
    throw new Error(`amountUsd must be a number >= ${config.billing.minTopupUsd}`);
  }
  if (!isAllowedRedirectUrl(successUrl) || !isAllowedRedirectUrl(cancelUrl)) {
    throw new Error('successUrl/cancelUrl must be on an allowed origin (see ALLOWED_ORIGINS)');
  }

  // Reject unsupported/malformed currencies before creating any account or
  // Stripe session — a bad currency is a 400, never a silent USD default.
  const { code, minorUnits, usdPerUnit } = resolveCurrency(currency);

  const { accountId, rawKey } = await createAccount();
  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: code,
          product_data: { name: 'Arbiter API credit' },
          unit_amount: Math.round(amountUsd * minorUnits),
        },
        quantity: 1,
      },
    ],
    // Snapshot the FX rate (as stroops per major unit) at checkout time so
    // the webhook credits at the rate the customer actually saw, immune to
    // rate drift between checkout and webhook delivery.
    metadata: {
      accountId,
      currency: code,
      stroopsPerUnit: String(fiatToStroops(1, code)),
      usdPerUnit: String(usdPerUnit),
    },
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

  // Credit using the FX rate locked in at checkout time (snapshotted into
  // session metadata), NOT a rate refetched now — rate drift between
  // checkout and webhook delivery must not change the credited amount.
  // amount_total is in the currency's minor units (integer, no float).
  const currency = session.metadata?.currency || 'usd';
  const { minorUnits } = resolveCurrency(currency);
  const stroopsPerUnit = BigInt(session.metadata?.stroopsPerUnit || String(fiatToStroops(1, currency)));
  const stroopsPerMinorUnit = stroopsPerUnit / BigInt(minorUnits);
  const amountStroops = BigInt(session.amount_total) * stroopsPerMinorUnit;
  await store.incrBy(`credit:${accountId}`, Number(amountStroops));
}
