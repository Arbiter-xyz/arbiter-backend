import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { config } from './config.js';
import { store } from './store.js';
import { logger } from './logger.js';
import { getDeliveryTargets, resolveJobOwner, deactivateWebhook, isBlockedAddress } from './webhooks.js';

/**
 * Signed settlement webhooks: the sending-side mirror of billing.js's
 * handleStripeWebhook(), which verifies Stripe's signed webhooks.
 *
 * ── Signing convention (what an integrator verifies) ─────────────────────
 *
 *   POST <registered url>
 *   Content-Type: application/json
 *   X-Arbiter-Event: question.settled
 *   X-Arbiter-Event-Id: evt_...        same across retries: dedupe on it
 *   X-Arbiter-Webhook-Id: wh_...
 *   X-Arbiter-Delivery-Attempt: 1..N
 *   X-Arbiter-Signature: t=<unix seconds>,v1=<hex>
 *
 *   v1 = hex(HMAC-SHA256(key = the whsec_... secret shown at registration,
 *                        message = "<t>" + "." + <raw request body bytes>))
 *
 * The receiver recomputes v1 over the RAW body exactly as received, before
 * any JSON parsing, and compares in constant time. It should also reject a
 * `t` more than ~5 minutes old, so a captured delivery can't be replayed
 * later. Every attempt is re-signed with a fresh `t`, so a late retry still
 * passes that check. verifyWebhookSignature() below is the reference
 * implementation.
 *
 * Body: { id, type: 'question.settled', createdAt, data: { jobId, ...job } }.
 * `data` has the same shape GET /oracle/:jobId returns (status 'settled',
 * outcome, answer, confidence, ...).
 *
 * ── Delivery guarantees ──────────────────────────────────────────────────
 *
 * Settlement never waits on this. enqueueSettlementWebhooks() returns
 * synchronously and never throws; all work happens after the settle path
 * has moved on, the same fail-safe posture as push.js's notifyWorker().
 * Failures (network error, timeout, any non-2xx, including redirects, which
 * are not followed) are retried with exponential backoff, up to
 * config.webhooks.maxAttempts attempts in total, then abandoned with an
 * error log. 410 Gone deactivates the registration. Retries are in-process
 * timers, so a restart mid-backoff drops the remaining attempts for that
 * event. That's acceptable for v1 because GET /oracle/:jobId remains the
 * source of truth, and it's logged so operators can see it.
 */

export const SIGNATURE_HEADER = 'x-arbiter-signature';
const USER_AGENT = 'Arbiter-Webhooks/1.0';

export function computeSignature(secret, timestamp, rawBody) {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

export function signPayload(secret, rawBody, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, rawBody)}`;
}

/** Reference receiver-side check: true only for a signature made with
 * `secret` over exactly `rawBody`, no older than `toleranceSec`. */
export function verifyWebhookSignature(secret, rawBody, header, { toleranceSec = 300, now = Date.now() } = {}) {
  if (typeof header !== 'string') return false;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;

  const expected = Buffer.from(computeSignature(secret, t, rawBody), 'hex');
  const given = Buffer.from(parts.v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function buildSettlementEvent(jobId, job) {
  return {
    id: `evt_${randomBytes(12).toString('hex')}`,
    type: 'question.settled',
    createdAt: Date.now(),
    data: { jobId: String(jobId), ...job },
  };
}

/** dns.lookup wrapper that refuses private/reserved results, and returns
 * the checked address so the connection goes to the address that was
 * validated. That closes the DNS-rebinding gap between validation and
 * connect. */
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: false }, (err, address, family) => {
    if (err) return callback(err);
    if (!config.webhooks.allowInsecureTargets && isBlockedAddress(address)) {
      return callback(Object.assign(new Error(`webhook host ${hostname} resolved to a blocked address`), { code: 'EBLOCKED' }));
    }
    callback(null, address, family);
  });
}

/** One HTTP POST. Resolves with the response status; rejects on network
 * error or timeout. The response body is drained and ignored. */
function postOnce(url, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(
      target,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(body) },
        lookup: guardedLookup,
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error(`timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(body);
  });
}

// Deliberately NOT unref()'d: a pending retry must keep the process alive
// long enough to run, or it's silently dropped. It's bounded by
// maxAttempts x backoff, so it can't hold a process open indefinitely.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function backoffDelayMs(retryNumber, baseDelayMs = config.webhooks.retryBaseDelayMs, random = Math.random) {
  const exp = baseDelayMs * 2 ** (retryNumber - 1);
  return Math.round(exp + exp * 0.2 * random());
}

async function recordDelivery(webhookId, patch) {
  const key = `webhook-delivery:${webhookId}`;
  const current = (await store.get(key)) || { delivered: 0, failed: 0 };
  const { outcome, ...rest } = patch;
  const next = { ...current, ...rest };
  if (outcome) next.lastOutcome = outcome;
  if (outcome === 'delivered') next.delivered = current.delivered + 1;
  if (outcome === 'failed') next.failed = current.failed + 1;
  await store.set(key, next);
}

/**
 * Delivers one event to one registration, retrying with backoff. Resolves
 * (never rejects) with { ok, attempts, status }.
 */
export async function deliverWithRetry(target, event, options = {}) {
  const {
    maxAttempts = config.webhooks.maxAttempts,
    baseDelayMs = config.webhooks.retryBaseDelayMs,
    timeoutMs = config.webhooks.timeoutMs,
  } = options;
  const body = JSON.stringify(event);
  const log = logger.child({ webhookId: target.id, eventId: event.id, jobId: event.data?.jobId });
  let lastStatus = null;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const headers = {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      'x-arbiter-event': event.type,
      'x-arbiter-event-id': event.id,
      'x-arbiter-webhook-id': target.id,
      'x-arbiter-delivery-attempt': String(attempt),
      [SIGNATURE_HEADER]: signPayload(target.secret, body),
    };
    try {
      lastStatus = await postOnce(target.url, body, headers, timeoutMs);
      lastError = null;
    } catch (err) {
      lastStatus = null;
      lastError = err.code || err.message;
    }

    const at = Date.now();
    if (lastStatus >= 200 && lastStatus < 300) {
      log.info({ attempt, status: lastStatus }, 'webhook delivered');
      await recordDelivery(target.id, { lastAttemptAt: at, lastStatus, lastError: null, lastEventId: event.id, outcome: 'delivered' }).catch(() => {});
      return { ok: true, attempts: attempt, status: lastStatus };
    }
    if (lastStatus === 410) {
      log.warn({ attempt }, 'webhook receiver answered 410 Gone — deactivating registration');
      await deactivateWebhook(target.id, 'receiver answered 410 Gone').catch(() => {});
      await recordDelivery(target.id, { lastAttemptAt: at, lastStatus, lastError: null, lastEventId: event.id, outcome: 'failed' }).catch(() => {});
      return { ok: false, attempts: attempt, status: lastStatus };
    }

    await recordDelivery(target.id, { lastAttemptAt: at, lastStatus, lastError, lastEventId: event.id }).catch(() => {});
    if (attempt < maxAttempts) {
      const delayMs = backoffDelayMs(attempt, baseDelayMs);
      log.warn({ attempt, maxAttempts, status: lastStatus, error: lastError, delayMs }, 'webhook delivery failed, retrying');
      await sleep(delayMs);
    }
  }

  log.error({ attempts: maxAttempts, status: lastStatus, error: lastError }, 'webhook delivery abandoned after max attempts');
  await recordDelivery(target.id, { outcome: 'failed' }).catch(() => {});
  return { ok: false, attempts: maxAttempts, status: lastStatus };
}

/** Looks up the settled job's owner and delivers to each of their active
 * registrations concurrently. Resolves once every delivery (including
 * retries) has finished. Exposed for tests; production code uses
 * enqueueSettlementWebhooks(). */
export async function dispatchSettlementWebhooks(jobId, job, options) {
  const owner = await resolveJobOwner(jobId, job);
  const targets = await getDeliveryTargets(owner);
  if (targets.length === 0) return [];
  const event = buildSettlementEvent(jobId, job);
  return Promise.all(targets.map((t) => deliverWithRetry(t, event, options)));
}

/** Fire-and-forget hook for oracle.js's settle paths. Returns immediately,
 * never throws, and does all its work after the current settle call has
 * completed. */
export function enqueueSettlementWebhooks(jobId, job) {
  setImmediate(() => {
    dispatchSettlementWebhooks(jobId, job).catch((err) => {
      logger.error({ err, jobId }, 'settlement webhook dispatch failed');
    });
  });
}
