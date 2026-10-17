import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SIGNATURE_HEADER,
  computeSignature,
  signPayload,
  verifyWebhookSignature,
  buildSettlementEvent,
  backoffDelayMs,
  deliverWithRetry,
  recoverPendingWebhookDeliveries,
} from '../src/webhookDelivery.js';
import { store } from '../src/store.js';

test.beforeEach(async () => {
  await store.delete('webhook-inflight-index');
});

test('signPayload and verifyWebhookSignature verify valid HMAC signatures and reject tampering or stale timestamps', () => {
  const secret = 'whsec_test_secret_123';
  const body = JSON.stringify({ id: 'evt_1', type: 'question.settled' });
  const nowSec = 1_700_000_000;
  const header = signPayload(secret, body, nowSec);

  assert.equal(
    verifyWebhookSignature(secret, body, header, {
      toleranceSec: 300,
      now: (nowSec + 120) * 1000,
    }),
    true,
  );

  // Tampered payload fails
  assert.equal(
    verifyWebhookSignature(secret, `${body} `, header, {
      toleranceSec: 300,
      now: nowSec * 1000,
    }),
    false,
  );

  // Outside tolerance window fails
  assert.equal(
    verifyWebhookSignature(secret, body, header, {
      toleranceSec: 300,
      now: (nowSec + 600) * 1000,
    }),
    false,
  );

  // Malformed header fails
  assert.equal(verifyWebhookSignature(secret, body, 'bad-header'), false);
  assert.equal(verifyWebhookSignature(secret, body, null), false);
  assert.equal(computeSignature(secret, nowSec, body).length, 64);
});

test('backoffDelayMs computes exponential backoff with bounded 0..20% jitter', () => {
  assert.equal(backoffDelayMs(1, 100, () => 0), 100);
  assert.equal(backoffDelayMs(1, 100, () => 1), 120);
  assert.equal(backoffDelayMs(3, 100, () => 0.5), 440);
});

test('deliverWithRetry retries 5xx failures, succeeds on 2xx, and stops immediately on 410 Gone', async () => {
  const target = {
    id: 'wh_retry_test',
    url: 'https://example.com/hook',
    secret: 'whsec_abc',
  };
  const event = buildSettlementEvent('job-10', { status: 'settled', answer: 'yes' });

  const seenAttempts = [];
  const res = await deliverWithRetry(target, event, {
    maxAttempts: 3,
    baseDelayMs: 1,
    post: async (_url, rawBody, headers) => {
      seenAttempts.push(Number(headers['x-arbiter-delivery-attempt']));
      assert.equal(
        verifyWebhookSignature(target.secret, rawBody, headers[SIGNATURE_HEADER]),
        true,
      );
      return seenAttempts.length === 1 ? 503 : 200;
    },
  });

  assert.deepEqual(res, { ok: true, attempts: 2, status: 200 });
  assert.deepEqual(seenAttempts, [1, 2]);
  assert.deepEqual((await store.get('webhook-inflight-index')) || [], []);

  // 410 Gone aborts retries on the first attempt
  let calls410 = 0;
  const goneRes = await deliverWithRetry(target, event, {
    maxAttempts: 4,
    baseDelayMs: 1,
    post: async () => {
      calls410 += 1;
      return 410;
    },
  });
  assert.deepEqual(goneRes, { ok: false, attempts: 1, status: 410 });
  assert.equal(calls410, 1);
});

test('deliverWithRetry persists in-flight retry state mid-backoff and recoverPendingWebhookDeliveries resumes after restart (#289)', async () => {
  const target = {
    id: 'wh_recover_1',
    url: 'https://example.com/recover',
    secret: 'whsec_recover',
  };
  const event = buildSettlementEvent('job-99', { status: 'settled', answer: '42' });
  const inflightId = `${target.id}:${event.id}`;

  // Simulate a process crash mid-backoff after attempt 1 failed (nextAttempt = 2 of 3).
  await store.set(`webhook-inflight:${inflightId}`, {
    target,
    event,
    nextAttempt: 2,
    maxAttempts: 3,
    updatedAt: Date.now(),
  });
  await store.set('webhook-inflight-index', [inflightId]);

  const resumedAttempts = [];
  const recovered = await recoverPendingWebhookDeliveries({
    baseDelayMs: 1,
    post: async (_url, _body, headers) => {
      const attempt = Number(headers['x-arbiter-delivery-attempt']);
      resumedAttempts.push(attempt);
      return attempt === 2 ? 500 : 204;
    },
  });

  assert.deepEqual(resumedAttempts, [2, 3]);
  assert.deepEqual(recovered, [
    { id: inflightId, ok: true, attempts: 3, status: 204 },
  ]);
  assert.equal(await store.get(`webhook-inflight:${inflightId}`), null);
  assert.deepEqual((await store.get('webhook-inflight-index')) || [], []);
});
