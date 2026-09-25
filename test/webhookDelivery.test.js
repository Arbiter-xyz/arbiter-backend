import './helpers/webhook-test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import {
  deliverWithRetry,
  dispatchSettlementWebhooks,
  verifyWebhookSignature,
  signPayload,
  backoffDelayMs,
  buildSettlementEvent,
} from '../src/webhookDelivery.js';
import { registerWebhook, listWebhooks, getDeliveryTargets } from '../src/webhooks.js';
import { startFulfillment } from '../src/oracle.js';
import { getJob } from '../src/jobs.js';
import { resolveTier } from '../src/pricing.js';

// #56 — HMAC-signed settlement delivery with bounded retry/backoff.
// Receivers are real local HTTP servers; the signature is re-derived here
// with node:crypto directly (not the module's helper) to prove an external
// integrator can verify it from the documented convention alone.

/** A local receiver that answers each request with the next status in
 * `statuses` (repeating the last one) and records what it got. */
async function receiver(statuses = [200]) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ headers: req.headers, body, at: Date.now() });
      res.statusCode = statuses[Math.min(requests.length - 1, statuses.length - 1)];
      res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/hook`;
  return { url, requests, close: () => new Promise((r) => server.close(r)) };
}

const owner = () => `payer:GOWNER${Date.now()}${Math.random().toString(36).slice(2)}`;
const numericId = () => String(Date.now() * 1000 + Math.floor(Math.random() * 1000));

function expectedSignature(secret, header, rawBody) {
  const t = /t=(\d+)/.exec(header)[1];
  return createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
}

async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met in time');
}

test('signature convention: HMAC-SHA256 over "<t>.<raw body>", verifiable independently', () => {
  const secret = 'whsec_test';
  const body = '{"a":1}';
  const header = signPayload(secret, body, 1_700_000_000);
  assert.equal(header, `t=1700000000,v1=${createHmac('sha256', secret).update('1700000000.{"a":1}').digest('hex')}`);
  assert.equal(verifyWebhookSignature(secret, body, header, { now: 1_700_000_000_000 }), true);
  assert.equal(verifyWebhookSignature(secret, body + ' ', header, { now: 1_700_000_000_000 }), false); // body tampered
  assert.equal(verifyWebhookSignature('whsec_other', body, header, { now: 1_700_000_000_000 }), false); // wrong secret
  assert.equal(verifyWebhookSignature(secret, body, header, { now: 1_700_000_000_000 + 301_000 }), false); // replayed late
  assert.equal(verifyWebhookSignature(secret, body, 'garbage'), false);
});

test('a registered webhook receives a correctly signed POST with the settlement payload', async () => {
  const r = await receiver([200]);
  const o = owner();
  const hook = await registerWebhook(o, r.url);
  const [target] = await getDeliveryTargets(o);
  const job = { status: 'settled', outcome: 'resolved', answer: 'yes', confidence: 0.92, payer: 'GX' };
  const event = buildSettlementEvent('42', job);

  const result = await deliverWithRetry(target, event);
  await r.close();

  assert.deepEqual(result, { ok: true, attempts: 1, status: 200 });
  const [req] = r.requests;
  assert.equal(req.headers['content-type'], 'application/json');
  assert.equal(req.headers['x-arbiter-event'], 'question.settled');
  assert.equal(req.headers['x-arbiter-event-id'], event.id);
  assert.equal(req.headers['x-arbiter-webhook-id'], hook.id);
  assert.equal(req.headers['x-arbiter-delivery-attempt'], '1');

  const sigHeader = req.headers['x-arbiter-signature'];
  assert.match(sigHeader, /^t=\d+,v1=[0-9a-f]{64}$/);
  assert.equal(sigHeader.split('v1=')[1], expectedSignature(hook.secret, sigHeader, req.body));
  assert.equal(verifyWebhookSignature(hook.secret, req.body, sigHeader), true);

  const payload = JSON.parse(req.body);
  assert.equal(payload.type, 'question.settled');
  assert.deepEqual(payload.data, { jobId: '42', ...job });

  const [listed] = await listWebhooks(o);
  assert.equal(listed.lastDelivery.lastOutcome, 'delivered');
  assert.equal(listed.lastDelivery.delivered, 1);
});

test('a failing endpoint is retried with exponential backoff, then succeeds', async () => {
  const r = await receiver([500, 503, 200]);
  const o = owner();
  const hook = await registerWebhook(o, r.url);
  const [target] = await getDeliveryTargets(o);
  const event = buildSettlementEvent('7', { status: 'settled', outcome: 'refunded' });

  const result = await deliverWithRetry(target, event);
  await r.close();

  assert.deepEqual(result, { ok: true, attempts: 3, status: 200 });
  assert.deepEqual(r.requests.map((q) => q.headers['x-arbiter-delivery-attempt']), ['1', '2', '3']);
  // Same event id and body on every attempt (receivers dedupe on it); each
  // attempt freshly signed and independently verifiable.
  assert.equal(new Set(r.requests.map((q) => q.headers['x-arbiter-event-id'])).size, 1);
  assert.equal(new Set(r.requests.map((q) => q.body)).size, 1);
  for (const q of r.requests) assert.equal(verifyWebhookSignature(hook.secret, q.body, q.headers['x-arbiter-signature']), true);
  // Base delay is 25ms in this env: gaps are >= 25ms, then >= 50ms.
  const gap1 = r.requests[1].at - r.requests[0].at;
  const gap2 = r.requests[2].at - r.requests[1].at;
  assert.ok(gap1 >= 25, `first backoff ${gap1}ms`);
  assert.ok(gap2 >= 50, `second backoff ${gap2}ms`);
});

test('delivery gives up after the attempt cap and records the failure', async () => {
  const r = await receiver([500]);
  const o = owner();
  await registerWebhook(o, r.url);
  const [target] = await getDeliveryTargets(o);

  const result = await deliverWithRetry(target, buildSettlementEvent('8', { status: 'settled' }));
  await r.close();

  assert.deepEqual(result, { ok: false, attempts: 3, status: 500 }); // WEBHOOK_MAX_ATTEMPTS=3
  assert.equal(r.requests.length, 3);
  const [listed] = await listWebhooks(o);
  assert.equal(listed.lastDelivery.lastOutcome, 'failed');
  assert.equal(listed.lastDelivery.failed, 1);
  assert.equal(listed.active, true); // plain failures never deactivate
});

test('network errors (nothing listening) are retried and then abandoned without throwing', async () => {
  const r = await receiver([200]);
  const url = r.url;
  await r.close(); // port now refuses connections
  const o = owner();
  await registerWebhook(o, url);
  const [target] = await getDeliveryTargets(o);
  const result = await deliverWithRetry(target, buildSettlementEvent('9', { status: 'settled' }));
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
});

test('410 Gone stops retries and deactivates the registration', async () => {
  const r = await receiver([410]);
  const o = owner();
  await registerWebhook(o, r.url);
  const [target] = await getDeliveryTargets(o);
  const result = await deliverWithRetry(target, buildSettlementEvent('10', { status: 'settled' }));
  await r.close();

  assert.deepEqual(result, { ok: false, attempts: 1, status: 410 });
  assert.equal((await listWebhooks(o))[0].active, false);
  assert.deepEqual(await getDeliveryTargets(o), []);
});

test('redirects are not followed (a 3xx counts as a failed attempt)', async () => {
  const r = await receiver([302, 302, 302]);
  const o = owner();
  await registerWebhook(o, r.url);
  const [target] = await getDeliveryTargets(o);
  const result = await deliverWithRetry(target, buildSettlementEvent('11', { status: 'settled' }));
  await r.close();
  assert.equal(result.ok, false);
  assert.equal(r.requests.length, 3);
});

test('backoff doubles per retry with bounded jitter', () => {
  assert.equal(backoffDelayMs(1, 1000, () => 0), 1000);
  assert.equal(backoffDelayMs(2, 1000, () => 0), 2000);
  assert.equal(backoffDelayMs(5, 1000, () => 0), 16000);
  assert.equal(backoffDelayMs(1, 1000, () => 1), 1200);
});

test('each of an owner\'s active registrations gets the settlement; other owners get nothing', async () => {
  const [a, b, other] = await Promise.all([receiver(), receiver(), receiver()]);
  const payer = `GPAYER${Date.now()}`;
  await registerWebhook(`payer:${payer}`, a.url);
  await registerWebhook(`payer:${payer}`, b.url);
  await registerWebhook(owner(), other.url);

  const results = await dispatchSettlementWebhooks('12', { status: 'settled', outcome: 'resolved', payer });
  await Promise.all([a.close(), b.close(), other.close()]);

  assert.equal(results.length, 2);
  assert.equal(a.requests.length, 1);
  assert.equal(b.requests.length, 1);
  assert.equal(other.requests.length, 0);
});

test('end to end: settling a real job delivers a signed webhook to its payer', async () => {
  const r = await receiver([200]);
  const payer = `GE2E${Date.now()}`;
  const hook = await registerWebhook(`payer:${payer}`, r.url);
  const jobId = numericId();

  // Instant tier, fully offline (see webhook-test-env.js): settles as
  // refund_pending_timeout through oracle.js's real settleRefunded().
  await startFulfillment(jobId, { question: 'Will it rain?', category: 'weather' }, resolveTier('instant'), payer);

  await waitFor(() => r.requests.length === 1);
  await r.close();
  const job = await getJob(jobId);
  const req = r.requests[0];
  assert.equal(verifyWebhookSignature(hook.secret, req.body, req.headers['x-arbiter-signature']), true);
  const payload = JSON.parse(req.body);
  assert.equal(payload.data.jobId, jobId);
  assert.equal(payload.data.status, 'settled');
  assert.equal(payload.data.outcome, 'refund_pending_timeout');
  assert.equal(payload.data.category, 'weather');
  assert.deepEqual(payload.data, { jobId, ...job }); // same shape GET /oracle/:jobId returns
});

test('end to end: API-key jobs (paid from the fiat pool) notify the customer account, not the pool', async () => {
  const r = await receiver([200]);
  const accountId = `acct_${Date.now()}`;
  await registerWebhook(`account:${accountId}`, r.url);
  const jobId = numericId();

  await startFulfillment(jobId, { question: 'q?' }, resolveTier('instant'), 'GFIATPOOLADDRESS', { ownerAccountId: accountId });

  await waitFor(() => r.requests.length === 1);
  await r.close();
  assert.equal(JSON.parse(r.requests[0].body).data.jobId, jobId);
});

test('settlement completes normally, and promptly, even when every delivery fails', async () => {
  const r = await receiver([500]);
  const payer = `GDEAD${Date.now()}`;
  await registerWebhook(`payer:${payer}`, r.url);
  const jobId = numericId();

  await startFulfillment(jobId, { question: 'q?' }, resolveTier('instant'), payer);
  const settled = await waitFor(async () => {
    const job = await getJob(jobId);
    return job?.status === 'settled' ? job : null;
  });

  // The job reached its final state while the webhook was still being
  // retried: settlement never waits on delivery.
  assert.equal(settled.outcome, 'refund_pending_timeout');
  assert.ok(r.requests.length < 3, `settled before retries finished (saw ${r.requests.length} attempts)`);

  await waitFor(() => r.requests.length === 3); // retries run to the cap in the background
  await new Promise((resolve) => setTimeout(resolve, 150));
  await r.close();
  assert.equal(r.requests.length, 3); // ...and then stop
  assert.equal((await getJob(jobId)).outcome, 'refund_pending_timeout'); // settlement state untouched
});
