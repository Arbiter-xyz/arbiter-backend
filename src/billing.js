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
 *
 * Enterprise customers billed after the fact (net-30 invoicing) invert the
 * prepay-then-consume model: usage happens first, the bill comes later, and
 * accruing a balance owed is the entire point. Such accounts are marked
 * invoice-billed (see setInvoiceBilled/isInvoiceBilled) and their usage is
 * accumulated in a running total (recordInvoiceUsage) that is never
 * decremented by consumption, so a periodic report can be built from it.
 */
const STRIPE_RETRY_OPTS = { attempts: 2, timeoutMs: 8000, label: 'stripe.checkout.sessions.create' };

let stripeClient = null;
function getStripe() {
  if (!stripeClient) stripeClient = new Stripe(config.billing.stripeSecretKey, { maxNetworkRetries: 0 });
  return stripeClient;
}

/**
 * Processor-agnostic interface. Each concrete processor implements:
 *   - name: stable identifier used for per-processor availability and
 *     webhook event-id namespacing.
 *   - isConfigured(): whether this processor's env vars are present.
 *   - createCheckoutSession(amountUsd, successUrl, cancelUrl, currency):
 *     returns { checkoutUrl }.
 *   - verifyAndParseWebhook(rawBody, headers): verifies the processor's
 *     signature scheme and returns a normalized event
 *     { id, type, accountId, stroops } or null when the event is not a
 *     credit-granting event.
 * The Stripe implementation below is the original path, refactored to fit
 * this shape with zero behavior change.
 */

/**
 * Per-processor availability. isBillingConfigured() reports whether ANY
 * processor is usable (the pooled fiat balance is shared, so it is a
 * prerequisite for all of them); isProcessorConfigured() reports a single
 * processor. Both keep the existing Stripe env-var checks intact.
 */
export function isProcessorConfigured(name) {
  if (name === 'stripe') {
    return Boolean(config.billing.stripeSecretKey && config.billing.stripeWebhookSecret);
  }
  if (name === 'paypal') {
    return Boolean(config.billing.paypalClientId && config.billing.paypalClientSecret && config.billing.paypalWebhookId);
  }
  if (name === 'coinbase') {
    return Boolean(config.billing.coinbaseCommerceApiKey && config.billing.coinbaseCommerceWebhookSecret);
  }
  return false;
}

export function isBillingConfigured() {
  return Boolean(config.billing.fiatPoolAddress) && ['stripe', 'paypal', 'coinbase'].some(isProcessorConfigured);
}

function generateAccountId() {
  return `acct_${randomBytes(12).toString('hex')}`;
}

function generateApiKey() {
  return `ak_live_${randomBytes(32).toString('hex')}`;
}

export async function createAccount() {
  const accountId = generateAccountId();
  const rawKey = generateApiKey();
  // Durable, no TTL — same as every other identity record in this codebase
  // (worker/payer index entries, reputation).
  await store.set(`account:${accountId}`, { createdAt: Date.now(), suspended: false });
  await store.set(`apikey:${hashApiKey(rawKey)}`, { accountId });
  await store.set(`account-key:${accountId}`, hashApiKey(rawKey));
  return { accountId, rawKey, apiKey: rawKey };
}

/** Clears an account's suspended flag so its key resolves again via
 * apiKeyAuth.js. Admin-only, gated at the route layer. */
export async function unsuspendAccount(accountId) {
  const account = await store.get(`account:${accountId}`);
  if (!account) throw new Error(`no such account: ${accountId}`);
  await store.set(`account:${accountId}`, { ...account, suspended: false });
  return { accountId, suspended: false };
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

const noopCounter = { inc() {}, set() {} };
const billingReservationCount = globalThis.billingReservationCount || noopCounter;
const billingSettlementCount = globalThis.billingSettlementCount || noopCounter;
const fiatPoolBalanceStroops = globalThis.fiatPoolBalanceStroops || noopCounter;

export async function reserveCredit(accountId, maxStroops) {
  const ok = await store.decrIfAtLeast(`credit:${accountId}`, maxStroops);
  if (ok) billingReservationCount.inc({ outcome: 'reserved' });
  else billingReservationCount.inc({ outcome: 'insufficient' });
  return ok;
}

export async function settleReservation(accountId, reservedStroops, actualStroops, questionId) {
  const refund = reservedStroops - actualStroops;
  if (refund > 0) await store.incrBy(`credit:${accountId}`, refund);
  billingSettlementCount.inc({ outcome: actualStroops > 0 ? 'charged' : 'refunded' });
}

export async function restoreCredit(accountId, stroops) {
  if (stroops > 0) await store.incrBy(`credit:${accountId}`, stroops);
}

export function isAllowedRedirectUrl(url) {
  if (config.allowedOrigins.includes('*')) return true;
  try {
    return config.allowedOrigins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

export function getApplePayVerificationOrigin(url) {
  if (!isAllowedRedirectUrl(url)) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export const SUPPORTED_CURRENCIES = Object.freeze({
  usd: Object.freeze({ minorUnits: 100, usdPerUnit: 1 }),
  eur: Object.freeze({ minorUnits: 100, usdPerUnit: 1.08 }),
  gbp: Object.freeze({ minorUnits: 100, usdPerUnit: 1.27 }),
  jpy: Object.freeze({ minorUnits: 1, usdPerUnit: 0.0067 }),
});

export function resolveCurrency(currency = 'usd') {
  const code = String(currency || 'usd').trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(code) || !SUPPORTED_CURRENCIES[code]) {
    throw new Error(`unsupported currency: ${currency}`);
  }
  return { code, ...SUPPORTED_CURRENCIES[code] };
}

export async function createCheckoutSession(amountUsd, successUrl, cancelUrl, currency = 'usd') {
  const [processorName] = configuredProcessors();
  if (!processorName) throw new Error('no payment processor is configured');
  return getProcessor(processorName).createCheckoutSession(amountUsd, successUrl, cancelUrl, currency);
}

function fiatToStroops(amount, currency) {
  const { usdPerUnit } = resolveCurrency(currency);
  const usd = amount * usdPerUnit;
  return BigInt(Math.round(usd * Number(config.billing.usdToStroops)));
}

/**
 * Converts a major-unit webhook amount string/number into minor units using
 * the currency's configured minorUnits (e.g. 100 for USD/EUR, 1 for zero-decimal
 * currencies like JPY) and multiplies by stroopsPerMinorUnit (#273).
 */
export function webhookAmountToStroops(majorAmount, snapshot) {
  const { minorUnits } = snapshot.minorUnits
    ? { minorUnits: Number(snapshot.minorUnits) }
    : resolveCurrency(snapshot.currency || 'usd');
  const minorAmount = BigInt(Math.round(Number(majorAmount || 0) * minorUnits));
  const stroopsPerUnit = BigInt(snapshot.stroopsPerUnit);
  return (stroopsPerUnit * minorAmount) / BigInt(minorUnits);
}

const stripeProcessor = {
  name: 'stripe',
  isConfigured: () => isProcessorConfigured('stripe'),

  async createCheckoutSession(amountUsd, successUrl, cancelUrl, currency = 'usd') {
    if (!Number.isFinite(amountUsd) || amountUsd < config.billing.minTopupUsd) {
      throw new Error(`amountUsd must be a number >= ${config.billing.minTopupUsd}`);
    }
    if (!isAllowedRedirectUrl(successUrl) || !isAllowedRedirectUrl(cancelUrl)) {
      throw new Error('successUrl/cancelUrl must be on an allowed origin (see ALLOWED_ORIGINS)');
    }

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
      metadata: {
        accountId,
        currency: code,
        minorUnits: String(minorUnits),
        stroopsPerUnit: String(fiatToStroops(1, code)),
        usdPerUnit: String(usdPerUnit),
      },
      success_url: `${successUrl}?apiKey=${rawKey}`,
      cancel_url: cancelUrl,
    });

    return { checkoutUrl: session.url };
  },

  async verifyAndParseWebhook(rawBody, headers) {
    const signature = headers['stripe-signature'];
    const event = getStripe().webhooks.constructEvent(
      rawBody,
      signature,
      config.billing.stripeWebhookSecret,
    );
    if (event.type !== 'checkout.session.completed') return null;
    const session = event.data.object;
    const { accountId, stroopsPerUnit, currency, minorUnits } = session.metadata || {};
    if (!accountId || !stroopsPerUnit) return null;
    const resolvedMinorUnits = Number(minorUnits) || resolveCurrency(currency || 'usd').minorUnits;
    const stroops = (BigInt(stroopsPerUnit) * BigInt(session.amount_total || 0)) / BigInt(resolvedMinorUnits);
    return { id: event.id, type: event.type, accountId, stroops };
  },
};

export const paypalProcessor = {
  name: 'paypal',
  isConfigured: () => isProcessorConfigured('paypal'),

  async createCheckoutSession(amountUsd, successUrl, cancelUrl, currency = 'usd') {
    if (!Number.isFinite(amountUsd) || amountUsd < config.billing.minTopupUsd) {
      throw new Error(`amountUsd must be a number >= ${config.billing.minTopupUsd}`);
    }
    if (!isAllowedRedirectUrl(successUrl) || !isAllowedRedirectUrl(cancelUrl)) {
      throw new Error('successUrl/cancelUrl must be on an allowed origin (see ALLOWED_ORIGINS)');
    }
    const { code, minorUnits, usdPerUnit } = resolveCurrency(currency);
    const { accountId, rawKey } = await createAccount();
    const decimals = minorUnits === 1 ? 0 : 2;

    const auth = Buffer.from(
      `${config.billing.paypalClientId}:${config.billing.paypalClientSecret}`,
    ).toString('base64');
    const res = await fetch(`${config.billing.paypalApiBase}/v2/checkout/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            amount: { currency_code: code.toUpperCase(), value: amountUsd.toFixed(decimals) },
            custom_id: accountId,
          },
        ],
        application_context: {
          return_url: `${successUrl}?apiKey=${rawKey}`,
          cancel_url: cancelUrl,
        },
      }),
    });
    if (!res.ok) throw new Error(`paypal order creation failed: ${res.status}`);
    const order = await res.json();
    const approve = (order.links || []).find((l) => l.rel === 'approve');
    if (!approve) throw new Error('paypal order missing approve link');
    await store.set(`paypal-order:${order.id}`, {
      accountId,
      currency: code,
      minorUnits,
      stroopsPerUnit: String(fiatToStroops(1, code)),
      usdPerUnit: String(usdPerUnit),
    });
    return { checkoutUrl: approve.href };
  },

  async verifyAndParseWebhook(rawBody, headers) {
    const auth = Buffer.from(
      `${config.billing.paypalClientId}:${config.billing.paypalClientSecret}`,
    ).toString('base64');
    const verifyRes = await fetch(`${config.billing.paypalApiBase}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
      body: JSON.stringify({
        auth_algo: headers['paypal-auth-algo'],
        cert_url: headers['paypal-cert-url'],
        transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'],
        transmission_time: headers['paypal-transmission-time'],
        webhook_id: config.billing.paypalWebhookId,
        webhook_event: JSON.parse(rawBody),
      }),
    });
    if (!verifyRes.ok) return null;
    const { verification_status: status } = await verifyRes.json();
    if (status !== 'SUCCESS') return null;

    const event = JSON.parse(rawBody);
    if (event.event_type !== 'PAYMENT.CAPTURE.COMPLETED') return null;
    const resource = event.resource || {};
    const accountId = resource.custom_id;
    const orderId = resource.supplementary_data?.related_ids?.order_id;
    if (!accountId || !orderId) return null;
    const snapshot = await store.get(`paypal-order:${orderId}`);
    if (!snapshot) return null;
    const currencyCode = snapshot.currency || resource.amount?.currency_code || 'usd';
    const stroops = webhookAmountToStroops(resource.amount?.value || 0, {
      ...snapshot,
      currency: currencyCode,
    });
    return { id: event.id, type: event.event_type, accountId, stroops };
  },
};

export const coinbaseProcessor = {
  name: 'coinbase',
  isConfigured: () => isProcessorConfigured('coinbase'),

  async createCheckoutSession(amountUsd, successUrl, cancelUrl, currency = 'usd') {
    if (!Number.isFinite(amountUsd) || amountUsd < config.billing.minTopupUsd) {
      throw new Error(`amountUsd must be a number >= ${config.billing.minTopupUsd}`);
    }
    if (!isAllowedRedirectUrl(successUrl) || !isAllowedRedirectUrl(cancelUrl)) {
      throw new Error('successUrl/cancelUrl must be on an allowed origin (see ALLOWED_ORIGINS)');
    }
    const { code, minorUnits, usdPerUnit } = resolveCurrency(currency);
    const { accountId, rawKey } = await createAccount();
    const decimals = minorUnits === 1 ? 0 : 2;

    const res = await fetch('https://api.commerce.coinbase.com/charges', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cc-api-key': config.billing.coinbaseCommerceApiKey,
        'x-cc-version': '2018-03-22',
      },
      body: JSON.stringify({
        name: 'Arbiter API credit',
        pricing_type: 'fixed_price',
        local_price: { amount: amountUsd.toFixed(decimals), currency: code.toUpperCase() },
        metadata: { accountId },
        redirect_url: `${successUrl}?apiKey=${rawKey}`,
        cancel_url: cancelUrl,
      }),
    });
    if (!res.ok) throw new Error(`coinbase charge creation failed: ${res.status}`);
    const { data } = await res.json();
    await store.set(`coinbase-charge:${data.id}`, {
      accountId,
      currency: code,
      minorUnits,
      stroopsPerUnit: String(fiatToStroops(1, code)),
      usdPerUnit: String(usdPerUnit),
    });
    return { checkoutUrl: data.hosted_url };
  },

  async verifyAndParseWebhook(rawBody, headers) {
    const signature = headers['x-cc-webhook-signature'];
    if (!signature) return null;
    const { createHmac, timingSafeEqual } = await import('node:crypto');
    const expected = createHmac('sha256', config.billing.coinbaseCommerceWebhookSecret)
      .update(rawBody)
      .digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    const event = JSON.parse(rawBody);
    if (event.event?.type !== 'charge:confirmed') return null;
    const charge = event.event.data || {};
    const accountId = charge.metadata?.accountId;
    if (!accountId) return null;
    const snapshot = await store.get(`coinbase-charge:${charge.id}`);
    if (!snapshot) return null;
    const currencyCode = snapshot.currency || charge.pricing?.local?.currency || 'usd';
    const stroops = webhookAmountToStroops(charge.pricing?.local?.amount || 0, {
      ...snapshot,
      currency: currencyCode,
    });
    return { id: event.id, type: event.event.type, accountId, stroops };
  },
};

const PROCESSORS = {
  stripe: stripeProcessor,
  paypal: paypalProcessor,
  coinbase: coinbaseProcessor,
};

/** Resolves a processor by name, throwing for unknown names. */
export function getProcessor(name) {
  const processor = PROCESSORS[name];
  if (!processor) throw new Error(`unknown payment processor: ${name}`);
  return processor;
}

/** Names of every processor that is currently configured. */
export function configuredProcessors() {
  return Object.keys(PROCESSORS).filter((name) => PROCESSORS[name].isConfigured());
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

/**
 * Per-customer usage analytics. Unlike stats.js's incrementStat() counters
 * (global, platform-wide, sandbox-excluded), these are keyed per account so
 * a customer can see their own per-endpoint/per-tier call patterns via
 * GET /billing/usage. Keyed usage:{accountId}:{endpoint}:{tier}:{day} so a
 * rolling window can be read back without scanning the whole keyspace.
 *
 * Sandbox traffic is excluded by the caller (server.js), consistent with
 * how stats.js already excludes it from platform-wide numbers.
 */
const USAGE_WINDOW_DAYS = 30;

function usageDay(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

/** Records one API call for an account. Called from the resolveApiKey()-
 * gated request flow in server.js's POST /oracle, alongside the existing
 * incrementStat() calls. */
export async function recordUsage(accountId, endpoint, tier, ts = Date.now()) {
  if (!accountId || !endpoint || !tier) return;
  await store.incrBy(`usage:${accountId}:${endpoint}:${tier}:${usageDay(ts)}`, 1);
}

/**
 * Reads the pooled fiat balance for the /metrics endpoint (issue #162).
 * Returns null when billing isn't configured so the metrics route can skip
 * the gauge entirely rather than reporting a misleading zero. The balance
 * itself is read from the same store key the on-chain pool accounting
 * already maintains; this is a read-only accessor, not a new source of
 * truth.
 */
export async function getFiatPoolBalanceStroops() {
  if (!isBillingConfigured()) return null;
  const balance = await store.get(`pool:${config.billing.fiatPoolAddress}`);
  return balance || 0;
}

/**
 * Refreshes the fiat-pool-balance gauge. Called by the /metrics handler
 * before scraping so the gauge reflects the current pool rather than a
 * stale value from process start. No-op when billing is unconfigured.
 */
export async function refreshFiatPoolBalanceMetric() {
  const balance = await getFiatPoolBalanceStroops();
  if (balance === null) return;
  fiatPoolBalanceStroops.set(balance);
}
