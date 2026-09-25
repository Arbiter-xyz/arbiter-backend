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
  await store.set(`account:${accountId}`, { createdAt: Date.now(), suspended: false });
  await store.set(`apikey:${hashApiKey(rawKey)}`, { accountId });
  return { accountId, rawKey };
}

/**
 * Anomaly-based auto-suspend (issue #153). A compromised key being hammered
 * or a runaway retry loop burns through a real balance via reserveCredit()
 * (which reserves the surge-case ceiling per call, before the actual price
 * is even known). The per-IP rate ceiling in rateLimit.js can't see a
 * distributed pattern against one account, so we track a per-account
 * trailing-window velocity signal and flip a suspension flag on the account
 * record when it trips. resolveApiKey() (apiKeyAuth.js) fails closed on
 * that flag before the request ever reaches reserveCredit().
 *
 * The signal is deliberately simple and explainable — a fixed threshold
 * over a trailing window, mirroring dispatch.js's computeSmoothedCount()
 * trailing-sample approach rather than inventing a new statistical model.
 * Per-account baselining is a deliberate v1 gap (real false-positive risk
 * against a customer whose legitimate traffic just grew); operators can
 * unsuspend via the admin-gated endpoint below.
 */
export const SUSPEND_WINDOW_MS = 60 * 1000;
export const SUSPEND_MAX_CALLS_PER_WINDOW = 600;

/**
 * Pure, exported velocity/threshold check — same testability pattern as
 * computeSmoothedCount/stakeGateAllows/surgeMultiplier. Given the timestamps
 * of recent calls for one account and the current time, returns true when
 * the count within the trailing window exceeds the fixed ceiling. No store
 * or timer access, so it can be unit-tested independently.
 */
export function isAbusiveVelocity(timestamps, now = Date.now(), windowMs = SUSPEND_WINDOW_MS, maxCalls = SUSPEND_MAX_CALLS_PER_WINDOW) {
  if (!Array.isArray(timestamps)) return false;
  const cutoff = now - windowMs;
  let count = 0;
  for (const ts of timestamps) {
    if (typeof ts === 'number' && ts > cutoff) count += 1;
  }
  return count > maxCalls;
}

/**
 * Records one call for the account's velocity window and suspends the
 * account if the trailing-window count trips the threshold. Called inline
 * from reserveCredit() so the check runs on the same path that spends real
 * balance, before the reservation is attempted. The window is stored as a
 * plain array under a short TTL so it self-expires without a sweep.
 */
export async function recordCallVelocity(accountId, now = Date.now()) {
  if (!accountId) return false;
  const key = `velocity:${accountId}`;
  const timestamps = (await store.get(key)) || [];
  const cutoff = now - SUSPEND_WINDOW_MS;
  const recent = timestamps.filter((ts) => typeof ts === 'number' && ts > cutoff);
  recent.push(now);
  await store.set(key, recent, SUSPEND_WINDOW_MS * 2);
  if (isAbusiveVelocity(recent, now)) {
    await suspendAccount(accountId, 'velocity');
    return true;
  }
  return false;
}

/** Flips the suspension flag on the account record. Fails closed: a missing
 * account record is left alone (resolveApiKey() already rejects unknown
 * keys), and the flag is what resolveApiKey() checks. */
export async function suspendAccount(accountId, reason = 'manual') {
  const account = await store.get(`account:${accountId}`);
  if (!account) return false;
  await store.set(`account:${accountId}`, { ...account, suspended: true, suspendedAt: Date.now(), suspendedReason: reason });
  logger.warn({ accountId, reason }, 'api key account suspended');
  return true;
}

/** Operator override path (issue #153 open question 2): clears the
 * suspension flag so a wrongly-suspended key can be restored. Exposed via
 * the admin-gated endpoint in server.js. */
export async function unsuspendAccount(accountId) {
  const account = await store.get(`account:${accountId}`);
  if (!account) return false;
  await store.set(`account:${accountId}`, { ...account, suspended: false, suspendedAt: null, suspendedReason: null });
  logger.info({ accountId }, 'api key account unsuspended');
  return true;
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
 *
 * Also the inline trigger for the anomaly sweep (issue #153): the velocity
 * check runs here, on the same path that spends real balance, so a key
 * that trips the threshold is suspended before its next reservation. A
 * suspended account is rejected earlier by resolveApiKey(), so this is a
 * backstop for in-flight requests rather than the primary gate.
 */
export async function reserveCredit(accountId, maxStroops) {
  await recordCallVelocity(accountId);
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
 * Reads back the last USAGE_WINDOW_DAYS days of usage for an account,
 * aggregated per endpoint and per tier. Retu

/* … truncated 1336 chars — edit only what you need near the top … */
