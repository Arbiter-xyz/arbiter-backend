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
 *
 * Multiple processors (Stripe, PayPal, Coinbase Commerce) implement the
 * same processor-agnostic interface below — createCheckoutSession() and
 * verifyAndParseWebhook() — mirroring how store.js exposes MemoryStore and
 * RedisStore behind one `store` export. The Stripe path is the original
 * concrete instance and is unchanged in behavior; the additional
 * processors are additive, not a replacement.
 */

let stripeClient = null;
function getStripe() {
  if (!stripeClient) stripeClient = new Stripe(config.billing.stripeSecretKey);
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

/**
 * Stripe processor — the original concrete implementation of the
 * processor-agnostic interface. Behavior is unchanged from before the
 * abstraction: same account creation, same session metadata snapshot, same
 * signature verification and idempotent event handling.
 */
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
  },

  /**
   * Verifies the Stripe signature (constructEvent) and normalizes the
   * event into the shared { id, type, accountId, stroops } shape. Returns
   * null for events that don't grant credit. Idempotency is keyed on the
   * processor-namespaced event id so a second processor's event ids can
   * never collide with Stripe's.
   */
  async verifyAndParseWebhook(rawBody, headers) {
    const signature = headers['stripe-signature'];
    const event = getStripe().webhooks.constructEvent(
      rawBody,
      signature,
      config.billing.stripeWebhookSecret,
    );
    if (event.type !== 'checkout.session.completed') return null;
    const session = event.data.object;
    const { accountId, stroopsPerUnit } = session.metadata || {};
    if (!accountId || !stroopsPerUnit) return null;
    const stroops = BigInt(stroopsPerUnit) * BigInt(session.amount_total || 0);
    return { id: event.id, type: event.type, accountId, stroops };
  },
};

/**
 * PayPal processor — additive second implementation of the same interface.
 * Uses PayPal Orders v2 for checkout and PayPal's webhook verification
 * endpoint for signature validation. Event ids are namespaced under
 * `paypal-event:` so they can never collide with Stripe's dedup keys.
 */
const paypalProcessor = {
  name: 'paypal',
  isConfigured: () => isProcessorConfigured('paypal'),

  async createCheckoutSession(amountUsd, successUrl, cancelUrl, currency = 'usd') {
    if (!Number.isFinite(amountUsd) || amountUsd < config.billing.minTopupUsd) {
      throw new Error(`amountUsd must be a number >= ${config.billing.minTopupUsd}`);
    }
    if (!isAllowedRedirectUrl(successUrl) || !isAllowedRedirectUrl(cancelUrl)) {
      throw new Error('successUrl/cancelUrl must be on an allowed origin (see ALLOWED_ORIGINS)');
    }
    const { code, usdPerUnit } = resolveCurrency(currency);
    const { accountId, rawKey } = await createAccount();

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
            amount: { currency_code: code.toUpperCase(), value: amountUsd.toFixed(2) },
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
    // Snapshot the FX rate so the webhook credits at the rate the customer saw.
    await store.set(`paypal-order:${order.id}`, {
      accountId,
      stroopsPerUnit: String(fiatToStroops(1, code)),
      usdPerUnit: String(usdPerUnit),
    });
    return { checkoutUrl: approve.href };
  },

  /**
   * Verifies the PayPal webhook signature via PayPal's verify-webhook-
   * signature endpoint, then normalizes a completed capture into the shared
   * event shape. Idempotency is keyed on `paypal-event:<id>`.
   */
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
    const stroops = BigInt(snapshot.stroopsPerUnit) * BigInt(Math.round(Number(resource.amount?.value || 0) * 100));
    return { id: event.id, type: event.event_type, accountId, stroops };
  },
};

/**
 * Coinbase Commerce processor — additive third implementation. Uses
 * Charges for checkout and the shared-secret HMAC-SHA256 signature scheme
 * for webhook verification. Event ids are namespaced under
 * `coinbase-event:`.
 */
const coinbaseProcessor = {
  name: 'coinbase',
  isConfigured: () => isProcessorConfigured('coinbase'),

  async createCheckoutSession(amountUsd, successUrl, cancelUrl, currency = 'usd') {
    if (!Number.isFinite(amountUsd) || amountUsd < config.billing.minTopupUsd) {
      throw new Error(`amountUsd must be a number >= ${config.billing.minTopupUsd}`);
    }
    if (!isAllowedRedirectUrl(successUrl) || !isAllowedRedirectUrl(cancelUrl)) {
      throw new Error('successUrl/cancelUrl must be on an allowed origin (see ALLOWED_ORIGINS)');
    }
    const { code, usdPerUnit } = resolveCurrency(currency);
    const { accountId, rawKey } = await createAccount();

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
        local_price: { amount: amountUsd.toFixed(2), currency: code.toUpperCase() },
        metadata: { accountId },
        redirect_url: `${successUrl}?apiKey=${rawKey}`,
        cancel_url: cancelUrl,
      }),
    });
    if (!res.ok) throw new Error(`coinbase charge creation failed: ${res.status}`);
    const { data } = await res.json();
    await store.set(`coinbase-charge:${data.id}`, {
      accountId,
      stroopsPerUnit: String(fiatToStroops(1, code)),
      usdPerUnit: String(usdPerUnit),
    });
    return { checkoutUrl: data.hosted_url };
  },

  /**
   * Verifies the Coinbase Commerce HMAC-SHA256 signature over the raw body
   * using the shared webhook secret, then normalizes a confirmed charge
   * into the shared event shape. Idempotency is keyed on
   * `coinbase-event:<id>`.
   */
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
    const stroops = BigInt(snapshot.stroopsPerUnit) * BigInt(Math.round(Number(charge.pricing?.local?.amount || 0) * 100));
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
 * Processor-agnostic checkout entry point. Defaults to Stripe so existing
 * callers (POST /billing/checkout) keep their exact behavior; callers may
 * pass a processor name to route to PayPal or Coinbase Commerce instead.
 */
export async function createCheckoutSession(amountUsd, successUrl, cancelUrl, currency = 'usd', processor = 'stripe') {
  return getProcessor(processor).createCheckoutSession(amountUsd, successUrl, cancelUrl, currency);
}

/**
 * Processor-agnostic webhook entry point. Verifies and parses the event
 * with the named processor, then applies the shared idempotent credit
 * grant. The dedup key is namespaced per processor so event ids from
 * different processors can never collide.
 */
export async function handleWebhook(processorName, rawBody, headers) {
  const processor = getProcessor(processorName);
  const event = await processor.verifyAndParseWebhook(rawBody, headers);
  if (!event) return { handled: false };

  const dedupKey = `${processor.name}-event:${event.id}`;
  const firstSeen = await store.setNX(dedupKey, { at: Date.now() });
  if (!firstSeen) return { handled: true, duplicate: true };

  await store.incrBy(`credit:${event.accountId}`, event.stroops);
  logger.info({ processor: processor.name, eventId: event.id, accountId: event.accountId }, 'billing credit granted');
  return { handled: true, duplicate: false };
}

/**
 * Backwards-compatible Stripe webhook handler. Kept so existing callers
 * (POST /billing/webhook) continue to work unchanged; delegates to the
 * shared handleWebhook() path.
 */
export async function handleStripeWebhook(rawBody, headers) {
  return handleWebhook('stripe', rawBody, headers);
}
