import './helpers/billing-test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Stripe from 'stripe';
import {
  reserveCredit,
  settleReservation,
  getCreditBalanceStroops,
  handleStripeWebhook,
  isAllowedRedirectUrl,
  createCheckoutSession,
  configuredProcessors,
  getProcessor,
} from '../src/billing.js';
import { config } from '../src/config.js';

/** config.allowedOrigins is an array nested inside a frozen config object
 * — Object.freeze is shallow, so the array's own contents are still
 * mutable, which is how these tests exercise both the wide-open default
 * and a restricted allowlist without needing a second process/env. */
function withAllowedOrigins(origins, fn) {
  const original = [...config.allowedOrigins];
  config.allowedOrigins.length = 0;
  config.allowedOrigins.push(...origins);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      config.allowedOrigins.length = 0;
      config.allowedOrigins.push(...original);
    });
}

function uniqueId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Builds a real, validly-signed Stripe webhook payload/header pair fully
// offline — Stripe.webhooks.generateTestHeaderString is a documented,
// no-network-call test utility (it does the exact same local HMAC signing
// constructEvent() later verifies), so this exercises the real signature
// verification path end to end without a live Stripe account.
function signedEvent(eventBody) {
  const payload = JSON.stringify(eventBody);
  const header = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: config.billing.stripeWebhookSecret,
  });
  return { payload, header };
}

function checkoutCompletedEvent({ eventId, accountId, amountCents }) {
  return {
    id: eventId,
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_1', amount_total: amountCents, metadata: { accountId } } },
  };
}

// Swaps global fetch for the duration of fn so processor HTTP calls can be
// asserted without hitting the network. Restores the original afterwards.
async function withMockFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// Coinbase Commerce signs webhooks with HMAC-SHA256 over the raw body using
// the shared secret, hex-encoded in the X-CC-Webhook-Signature header.
function coinbaseSignature(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

test('reserveCredit refuses to reserve more than the balance covers', async () => {
  const accountId = uniqueId('acct');
  assert.equal(await reserveCredit(accountId, 1_000_000), false);
});

test('reserve -> settle refunds the unused difference (surge estimate vs actual)', async () => {
  const accountId = uniqueId('acct');
  const { payload, header } = signedEvent(checkoutCompletedEvent({ eventId: uniqueId('evt'), accountId, amountCents: 1000 }));
  await handleStripeWebhook(payload, header); // credits 1000 cents = 100_000_000 stroops

  const reserved = await reserveCredit(accountId, 50_000_000); // worst-case ceiling
  assert.equal(reserved, true);
  await settleReservation(accountId, 50_000_000, 30_000_000); // actual price was lower

  // 100_000_000 - 50_000_000 (reserved) + (50_000_000 - 30_000_000) (refund) = 70_000_000
  assert.equal(await getCreditBalanceStroops(accountId), 70_000_000);
});

test('settleReservation with actual=0 refunds the reservation in full (charge failed entirely)', async () => {
  const accountId = uniqueId('acct');
  const { payload, header } = signedEvent(checkoutCompletedEvent({ eventId: uniqueId('evt'), accountId, amountCents: 1000 }));
  await handleStripeWebhook(payload, header);

  await reserveCredit(accountId, 40_000_000);
  await settleReservation(accountId, 40_000_000, 0);

  assert.equal(await getCreditBalanceStroops(accountId), 100_000_000); // fully back to where it started
});

test('handleStripeWebhook rejects a payload with a bad signature', async () => {
  const { payload } = signedEvent(checkoutCompletedEvent({ eventId: uniqueId('evt'), accountId: uniqueId('acct'), amountCents: 1000 }));
  await assert.rejects(() => handleStripeWebhook(payload, 't=1,v1=not-a-real-signature'));
});

test('handleStripeWebhook credits USD cents at the documented 1:1 USDC rate', async () => {
  const accountId = uniqueId('acct');
  const { payload, header } = signedEvent(checkoutCompletedEvent({ eventId: uniqueId('evt'), accountId, amountCents: 2500 })); // $25.00
  await handleStripeWebhook(payload, header);

  assert.equal(await getCreditBalanceStroops(accountId), 250_000_000); // 25 * 10_000_000
});

test('handleStripeWebhook is idempotent per Stripe event id (a retried delivery does not double-credit)', async () => {
  const accountId = uniqueId('acct');
  const eventId = uniqueId('evt');
  const { payload, header } = signedEvent(checkoutCompletedEvent({ eventId, accountId, amountCents: 1000 }));

  await handleStripeWebhook(payload, header);
  await handleStripeWebhook(payload, header); // simulated Stripe retry, same event id

  assert.equal(await getCreditBalanceStroops(accountId), 100_000_000); // credited once, not twice
});

test('handleStripeWebhook ignores event types other than checkout.session.completed', async () => {
  const accountId = uniqueId('acct');
  const { payload, header } = signedEvent({
    id: uniqueId('evt'),
    type: 'payment_intent.created',
    data: { object: { id: 'pi_test', amount_total: 1000, metadata: { accountId } } },
  });
  await handleStripeWebhook(payload, header);

  assert.equal(await getCreditBalanceStroops(accountId), 0);
});

// Regression coverage: successUrl/cancelUrl used to be passed straight
// through to Stripe with the freshly-minted API key appended to
// successUrl's query string, with no origin check at all — any caller
// could point successUrl at a domain they control and have Stripe hand
// the key straight to them once a real payer completed checkout.

test('isAllowedRedirectUrl allows any origin when ALLOWED_ORIGINS is wide open (the default)', () =>
  withAllowedOrigins(['*'], () => {
    assert.equal(isAllowedRedirectUrl('https://anything.example.com/success'), true);
  }));

test('isAllowedRedirectUrl restricts to the configured allowlist once one is set', () =>
  withAllowedOrigins(['https://app.arbiter.example'], () => {
    assert.equal(isAllowedRedirectUrl('https://app.arbiter.example/billing/success'), true);
    assert.equal(isAllowedRedirectUrl('https://attacker.example.com/steal'), false);
    assert.equal(isAllowedRedirectUrl('not-a-url'), false);
  }));

test('createCheckoutSession rejects a successUrl on a disallowed origin before any Stripe call', () =>
  withAllowedOrigins(['https://app.arbiter.example'], async () => {
    await assert.rejects(
      () => createCheckoutSession(20, 'https://attacker.example.com/steal?next=', 'https://app.arbiter.example/cancel'),
      /allowed origin/,
    );
  }));

test('createCheckoutSession rejects a disallowed cancelUrl too, not just successUrl', () =>
  withAllowedOrigins(['https://app.arbiter.example'], async () => {
    await assert.rejects(
      () => createCheckoutSession(20, 'https://app.arbiter.example/success', 'https://attacker.example.com/cancel'),
      /allowed origin/,
    );
  }));

// --- PayPal processor coverage -------------------------------------------
// Mirrors the Stripe coverage above: checkout-session creation against a
// mocked PayPal orders endpoint, plus webhook signature verification
// against both a valid and a tampered payload.

test('PayPal createCheckoutSession posts an order and returns the approve link as checkoutUrl', async () => {
  const paypal = getProcessor('paypal');
  assert.ok(paypal, 'paypal processor should be registered');

  await withMockFetch(
    () => jsonResponse({ id: 'ORDER-1', links: [{ rel: 'approve', href: 'https://www.paypal.com/checkoutnow?token=ORDER-1' }] }),
    async (calls) => {
      const session = await paypal.createCheckoutSession({
        amountCents: 2000,
        successUrl: 'https://app.arbiter.example/success',
        cancelUrl: 'https://app.arbiter.example/cancel',
      });

      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/v2\/checkout\/orders/);
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.intent, 'CAPTURE');
      assert.equal(body.purchase_units[0].amount.value, '20.00');
      assert.equal(body.purchase_units[0].amount.currency_code, 'USD');
      assert.equal(session.checkoutUrl, 'https://www.paypal.com/checkoutnow?token=ORDER-1');
    },
  );
});

test('PayPal verifyAndParseWebhook accepts a genuinely valid signature', async () => {
  const paypal = getProcessor('paypal');
  const payload = JSON.stringify({ id: uniqueId('evt'), event_type: 'CHECKOUT.ORDER.APPROVED' });
  const headers = {
    'paypal-transmission-id': 'tx-1',
    'paypal-transmission-time': '2024-01-01T00:00:00Z',
    'paypal-cert-url': 'https://api.paypal.com/cert.pem',
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-transmission-sig': 'valid-sig',
  };

  await withMockFetch(
    () => jsonResponse({ verification_status: 'SUCCESS' }),
    async (calls) => {
      const event = await paypal.verifyAndParseWebhook(payload, headers);
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /verify-webhook-signature/);
      assert.equal(event.event_type, 'CHECKOUT.ORDER.APPROVED');
    },
  );
});

test('PayPal verifyAndParseWebhook rejects a tampered payload (verification_status FAILURE)', async () => {
  const paypal = getProcessor('paypal');
  const payload = JSON.stringify({ id: uniqueId('evt'), event_type: 'CHECKOUT.ORDER.APPROVED' });
  const headers = {
    'paypal-transmission-id': 'tx-1',
    'paypal-transmission-time': '2024-01-01T00:00:00Z',
    'paypal-cert-url': 'https://api.paypal.com/cert.pem',
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-transmission-sig': 'tampered-sig',
  };

  await withMockFetch(
    () => jsonResponse({ verification_status: 'FAILURE' }),
    async () => {
      await assert.rejects(() => paypal.verifyAndParseWebhook(payload, headers));
    },
  );
});

// --- Coinbase Commerce processor coverage --------------------------------

test('Coinbase createCheckoutSession posts a charge and returns hosted_url as checkoutUrl', async () => {
  const coinbase = getProcessor('coinbase');
  assert.ok(coinbase, 'coinbase processor should be registered');

  await withMockFetch(
    () => jsonResponse({ data: { id: 'charge-1', hosted_url: 'https://commerce.coinbase.com/charges/charge-1' } }),
    async (calls) => {
      const session = await coinbase.createCheckoutSession({
        amountCents: 2000,
        successUrl: 'https://app.arbiter.example/success',
        cancelUrl: 'https://app.arbiter.example/cancel',
      });

      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/charges/);
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.pricing_type, 'fixed_price');
      assert.equal(body.local_price.amount, '20.00');
      assert.equal(body.local_price.currency, 'USD');
      assert.equal(session.checkoutUrl, 'https://commerce.coinbase.com/charges/charge-1');
    },
  );
});

test('Coinbase verifyAndParseWebhook accepts a genuinely valid HMAC signature', async () => {
  const coinbase = getProcessor('coinbase');
  const payload = JSON.stringify({ id: uniqueId('evt'), type: 'charge:confirmed' });
  const secret = config.billing.coinbaseWebhookSecret;
  const headers = { 'x-cc-webhook-signature': coinbaseSignature(payload, secret) };

  const event = await coinbase.verifyAndParseWebhook(payload, headers);
  assert.equal(event.type, 'charge:confirmed');
});

test('Coinbase verifyAndParseWebhook rejects a tampered payload (HMAC mismatch)', async () => {
  const coinbase = getProcessor('coinbase');
  const payload = JSON.stringify({ id: uniqueId('evt'), type: 'charge:confirmed' });
  const secret = config.billing.coinbaseWebhookSecret;
  // Sign the original body, then deliver a mutated one — the HMAC no longer matches.
  const headers = { 'x-cc-webhook-signature': coinbaseSignature(payload, secret) };
  const tampered = JSON.stringify({ id: uniqueId('evt'), type: 'charge:confirmed', amount: '999999' });

  await assert.rejects(() => coinbase.verifyAndParseWebhook(tampered, headers));
});

// --- Processor dispatch --------------------------------------------------

test('configuredProcessors lists every processor with credentials configured', () => {
  const processors = configuredProcessors();
  assert.ok(Array.isArray(processors));
  assert.ok(processors.includes('stripe'));
  assert.ok(processors.includes('paypal'));
  assert.ok(processors.includes('coinbase'));
});

test('getProcessor selects the requested processor when more than one is configured', () => {
  assert.equal(getProcessor('stripe')?.name, 'stripe');
  assert.equal(getProcessor('paypal')?.name, 'paypal');
  assert.equal(getProcessor('coinbase')?.name, 'coinbase');
  assert.equal(getProcessor('does-not-exist'), null);
});
