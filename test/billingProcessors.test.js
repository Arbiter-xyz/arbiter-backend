import './helpers/billing-test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  paypalProcessor,
  coinbaseProcessor,
  getProcessor,
  configuredProcessors,
  isProcessorConfigured,
  createCheckoutSession,
  handleWebhook,
} from '../src/billingProcessors.js';
import { getCreditBalanceStroops } from '../src/billing.js';
import { config } from '../src/config.js';
import { store } from '../src/store.js';

function withBillingConfig(overrides, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = config.billing[k];
    config.billing[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        config.billing[k] = v;
      }
    });
}

function withMockFetch(handler, fn) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls);
  };
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

test('getProcessor and configuredProcessors resolve Stripe, PayPal, and Coinbase processors (#223)', async () => {
  assert.equal(getProcessor('stripe').name, 'stripe');
  assert.equal(getProcessor('paypal').name, 'paypal');
  assert.equal(getProcessor('coinbase').name, 'coinbase');
  assert.throws(() => getProcessor('unknown'), /unknown payment processor: unknown/);

  await withBillingConfig(
    {
      stripeSecretKey: 'sk_test_1',
      stripeWebhookSecret: 'whsec_test_1',
      paypalClientId: '',
      paypalClientSecret: '',
      paypalWebhookId: '',
      coinbaseCommerceApiKey: '',
      coinbaseCommerceWebhookSecret: '',
    },
    () => {
      assert.deepEqual(configuredProcessors(), ['stripe']);
      assert.equal(isProcessorConfigured('paypal'), false);
      assert.equal(isProcessorConfigured('coinbase'), false);
    },
  );

  await withBillingConfig(
    {
      stripeSecretKey: 'sk_test_1',
      stripeWebhookSecret: 'whsec_test_1',
      paypalClientId: 'pp_client',
      paypalClientSecret: 'pp_secret',
      paypalWebhookId: 'pp_wh_id',
      coinbaseCommerceApiKey: 'cb_key',
      coinbaseCommerceWebhookSecret: 'cb_wh_secret',
    },
    () => {
      assert.deepEqual(configuredProcessors(), ['stripe', 'paypal', 'coinbase']);
      assert.equal(isProcessorConfigured('paypal'), true);
      assert.equal(isProcessorConfigured('coinbase'), true);
    },
  );
});

test('paypalProcessor.createCheckoutSession creates a PayPal Order and snapshots FX rate (#223)', async () => {
  await withBillingConfig(
    {
      paypalClientId: 'pp_client_123',
      paypalClientSecret: 'pp_secret_456',
      paypalWebhookId: 'pp_wh_789',
      paypalApiBase: 'https://api-m.sandbox.paypal.com',
    },
    async () => {
      await assert.rejects(
        () => paypalProcessor.createCheckoutSession(5, 'https://app.example.com/ok', 'https://app.example.com/cancel'),
        /amountUsd must be a number >= 10/,
      );

      await withMockFetch(
        async (url, init) => {
          assert.equal(url, 'https://api-m.sandbox.paypal.com/v2/checkout/orders');
          assert.equal(init.method, 'POST');
          const expectedAuth = Buffer.from('pp_client_123:pp_secret_456').toString('base64');
          assert.equal(init.headers.authorization, `Basic ${expectedAuth}`);
          const body = JSON.parse(init.body);
          assert.equal(body.intent, 'CAPTURE');
          assert.equal(body.purchase_units[0].amount.currency_code, 'USD');
          assert.equal(body.purchase_units[0].amount.value, '25.00');
          assert.match(body.application_context.return_url, /^https:\/\/app\.example\.com\/ok\?apiKey=ak_live_/);

          return new Response(
            JSON.stringify({
              id: 'ORDER-PP-101',
              links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-PP-101' }],
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          );
        },
        async (calls) => {
          const result = await createCheckoutSession(
            25,
            'https://app.example.com/ok',
            'https://app.example.com/cancel',
            'usd',
            'paypal',
          );
          assert.equal(result.checkoutUrl, 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-PP-101');
          assert.equal(calls.length, 1);

          const snapshot = await store.get('paypal-order:ORDER-PP-101');
          assert.ok(snapshot);
          assert.match(snapshot.accountId, /^acct_/);
          assert.equal(snapshot.stroopsPerUnit, '10000000');
        },
      );
    },
  );
});

test('paypalProcessor.verifyAndParseWebhook accepts verified signatures and rejects tampered ones (#223)', async () => {
  await withBillingConfig(
    {
      paypalClientId: 'pp_client_123',
      paypalClientSecret: 'pp_secret_456',
      paypalWebhookId: 'pp_wh_789',
      paypalApiBase: 'https://api-m.sandbox.paypal.com',
    },
    async () => {
      const accountId = 'acct_paypal_webhook_test';
      const orderId = 'ORDER-PP-WEBHOOK-1';
      await store.set(`paypal-order:${orderId}`, {
        accountId,
        stroopsPerUnit: '10000000',
        usdPerUnit: '1',
      });

      const rawBody = JSON.stringify({
        id: 'WH-PP-EVT-1',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          custom_id: accountId,
          amount: { value: '15.00', currency_code: 'USD' },
          supplementary_data: { related_ids: { order_id: orderId } },
        },
      });

      const headers = {
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123',
        'paypal-transmission-id': 'tx-123',
        'paypal-transmission-sig': 'valid-sig',
        'paypal-transmission-time': '2026-10-15T00:00:00Z',
      };

      // 1. Valid signature (PayPal verify-webhook-signature returns SUCCESS)
      await withMockFetch(
        async (url, init) => {
          assert.equal(url, 'https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature');
          const verifyPayload = JSON.parse(init.body);
          assert.equal(verifyPayload.webhook_id, 'pp_wh_789');
          assert.equal(verifyPayload.transmission_sig, 'valid-sig');
          return new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 });
        },
        async () => {
          const parsed = await paypalProcessor.verifyAndParseWebhook(rawBody, headers);
          assert.ok(parsed);
          assert.equal(parsed.id, 'WH-PP-EVT-1');
          assert.equal(parsed.type, 'PAYMENT.CAPTURE.COMPLETED');
          assert.equal(parsed.accountId, accountId);
          assert.equal(parsed.stroops, 10_000_000n * 1500n);
        },
      );

      // 2. Tampered signature (PayPal verify-webhook-signature returns FAILURE)
      await withMockFetch(
        async () => new Response(JSON.stringify({ verification_status: 'FAILURE' }), { status: 200 }),
        async () => {
          const parsed = await paypalProcessor.verifyAndParseWebhook(rawBody, {
            ...headers,
            'paypal-transmission-sig': 'tampered-sig',
          });
          assert.equal(parsed, null);
        },
      );
    },
  );
});

test('coinbaseProcessor.createCheckoutSession creates a Coinbase Commerce charge and snapshots FX rate (#223)', async () => {
  await withBillingConfig(
    {
      coinbaseCommerceApiKey: 'cb_api_key_test',
      coinbaseCommerceWebhookSecret: 'cb_wh_secret_test',
    },
    async () => {
      await assert.rejects(
        () => coinbaseProcessor.createCheckoutSession(2, 'https://app.example.com/ok', 'https://app.example.com/cancel'),
        /amountUsd must be a number >= 10/,
      );

      await withMockFetch(
        async (url, init) => {
          assert.equal(url, 'https://api.commerce.coinbase.com/charges');
          assert.equal(init.method, 'POST');
          assert.equal(init.headers['x-cc-api-key'], 'cb_api_key_test');
          assert.equal(init.headers['x-cc-version'], '2018-03-22');
          const body = JSON.parse(init.body);
          assert.equal(body.pricing_type, 'fixed_price');
          assert.deepEqual(body.local_price, { amount: '30.00', currency: 'USD' });
          assert.match(body.redirect_url, /^https:\/\/app\.example\.com\/ok\?apiKey=ak_live_/);

          return new Response(
            JSON.stringify({
              data: {
                id: 'CHARGE-CB-202',
                hosted_url: 'https://commerce.coinbase.com/charges/CHARGE-CB-202',
              },
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          );
        },
        async (calls) => {
          const result = await createCheckoutSession(
            30,
            'https://app.example.com/ok',
            'https://app.example.com/cancel',
            'usd',
            'coinbase',
          );
          assert.equal(result.checkoutUrl, 'https://commerce.coinbase.com/charges/CHARGE-CB-202');
          assert.equal(calls.length, 1);

          const snapshot = await store.get('coinbase-charge:CHARGE-CB-202');
          assert.ok(snapshot);
          assert.match(snapshot.accountId, /^acct_/);
          assert.equal(snapshot.stroopsPerUnit, '10000000');
        },
      );
    },
  );
});

test('coinbaseProcessor.verifyAndParseWebhook verifies HMAC-SHA256 signatures and rejects tampered payloads (#223)', async () => {
  const secret = 'cb_webhook_hmac_secret_999';
  await withBillingConfig(
    {
      coinbaseCommerceApiKey: 'cb_api_key_test',
      coinbaseCommerceWebhookSecret: secret,
    },
    async () => {
      const accountId = 'acct_coinbase_webhook_test';
      const chargeId = 'CHARGE-CB-WEBHOOK-1';
      await store.set(`coinbase-charge:${chargeId}`, {
        accountId,
        stroopsPerUnit: '10000000',
        usdPerUnit: '1',
      });

      const rawBody = JSON.stringify({
        id: 'CB-EVT-500',
        event: {
          type: 'charge:confirmed',
          data: {
            id: chargeId,
            metadata: { accountId },
            pricing: { local: { amount: '20.00', currency: 'USD' } },
          },
        },
      });

      const validSig = createHmac('sha256', secret).update(rawBody).digest('hex');

      // 1. Valid HMAC-SHA256 signature
      const parsed = await coinbaseProcessor.verifyAndParseWebhook(rawBody, {
        'x-cc-webhook-signature': validSig,
      });
      assert.ok(parsed);
      assert.equal(parsed.id, 'CB-EVT-500');
      assert.equal(parsed.type, 'charge:confirmed');
      assert.equal(parsed.accountId, accountId);
      assert.equal(parsed.stroops, 10_000_000n * 2000n);

      // 2. Tampered signature (same length, flipped hex character)
      const tamperedSig = (validSig[0] === 'a' ? 'b' : 'a') + validSig.slice(1);
      const rejectedTampered = await coinbaseProcessor.verifyAndParseWebhook(rawBody, {
        'x-cc-webhook-signature': tamperedSig,
      });
      assert.equal(rejectedTampered, null);

      // 3. Missing signature header
      const rejectedMissing = await coinbaseProcessor.verifyAndParseWebhook(rawBody, {});
      assert.equal(rejectedMissing, null);

      // 4. End-to-end handleWebhook idempotency
      const first = await handleWebhook('coinbase', rawBody, { 'x-cc-webhook-signature': validSig });
      assert.deepEqual(first, { handled: true, duplicate: false });
      const second = await handleWebhook('coinbase', rawBody, { 'x-cc-webhook-signature': validSig });
      assert.deepEqual(second, { handled: true, duplicate: true });
      assert.equal(await getCreditBalanceStroops(accountId), Number(10_000_000n * 2000n));
    },
  );
});
