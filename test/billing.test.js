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
  recordUsage,
} from '../src/billing.js';
import { config } from '../src/config.js';
import { store } from '../src/store.js';

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

function chargeRefundedEvent({ eventId, paymentIntent, amountRefundedCents }) {
  return {
    id: eventId,
    type: 'charge.refunded',
    data: { object: { id: 'ch_test_1', payment_intent: paymentIntent, amount_refunded: amountRefundedCents } },
  };
}

test('sequential partial refunds debit only the delta, not the cumulative amount_refunded', async () => {
  const accountId = uniqueId('acct');
  const paymentIntent = uniqueId('pi');
  const checkoutPayload = JSON.stringify({
    ...checkoutCompletedEvent({ eventId: uniqueId('evt'), accountId, amountCents: 1000 }),
    data: { object: { id: 'cs_test_1', amount_total: 1000, payment_intent: paymentIntent, metadata: { accountId } } },
  });
  const checkoutHeader = Stripe.webhooks.generateTestHeaderString({
    payload: checkoutPayload,
    secret: config.billing.stripeWebhookSecret,
  });
  await handleStripeWebhook(checkoutPayload, checkoutHeader); // credits 100_000_000 stroops

  const first = signedEvent(chargeRefundedEvent({ eventId: uniqueId('evt'), paymentIntent, amountRefundedCents: 300 }));
  await handleStripeWebhook(first.payload, first.header);
  assert.equal(await getCreditBalanceStroops(accountId), 70_000_000);

  // Second partial refund: Stripe reports the cumulative 600 cents, but only
  // the 300-cent delta is new — the account must not be debited 600 again.
  const second = signedEvent(chargeRefundedEvent({ eventId: uniqueId('evt'), paymentIntent, amountRefundedCents: 600 }));
  await handleStripeWebhook(second.payload, second.header);
  assert.equal(await getCreditBalanceStroops(accountId), 40_000_000);

  // An out-of-order/duplicate cumulative value yields a zero delta: no debit.
  const stale = signedEvent(chargeRefundedEvent({ eventId: uniqueId('evt'), paymentIntent, amountRefundedCents: 600 }));
  await handleStripeWebhook(stale.payload, stale.header);
  assert.equal(await getCreditBalanceStroops(accountId), 40_000_000);
});

test('a single full refund still debits the whole charge', async () => {
  const accountId = uniqueId('acct');
  const paymentIntent = uniqueId('pi');
  const payload = JSON.stringify({
    ...checkoutCompletedEvent({ eventId: uniqueId('evt'), accountId, amountCents: 1000 }),
    data: { object: { id: 'cs_test_1', amount_total: 1000, payment_intent: paymentIntent, metadata: { accountId } } },
  });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: config.billing.stripeWebhookSecret });
  await handleStripeWebhook(payload, header);

  const refund = signedEvent(chargeRefundedEvent({ eventId: uniqueId('evt'), paymentIntent, amountRefundedCents: 1000 }));
  await handleStripeWebhook(refund.payload, refund.header);
  assert.equal(await getCreditBalanceStroops(accountId), 0);
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

test('isAllowedRedirectUrl with a wildcard ALLOWED_ORIGINS allows only loopback redirects (the API key rides on successUrl)', () =>
  withAllowedOrigins(['*'], () => {
    assert.equal(isAllowedRedirectUrl('https://anything.example.com/success'), false);
    assert.equal(isAllowedRedirectUrl('http://localhost:5173/success'), true);
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

// --- Usage counters ------------------------------------------------------

test('recordUsage writes a per-day usage key that expires after the usage window', async () => {
  const accountId = uniqueId('acct');
  const endpoint = 'oracle';
  const tier = 'free';
  const ts = Date.now();
  const day = new Date(ts).toISOString().slice(0, 10);
  const key = `usage:${accountId}:${endpoint}:${tier}:${day}`;

  await recordUsage(accountId, endpoint, tier, ts);

  const value = await store.get(key);
  assert.equal(Number(value), 1);

  const ttl = await store.ttl(key);
  assert.ok(ttl > 0, `expected usage key ${key} to carry a TTL, got ${ttl}`);

  // TTL should be ~USAGE_WINDOW_DAYS + 1 = 31 days, allowing a generous
  // slack for the time elapsed between the write and this assertion.
  const expectedSeconds = 31 * 24 * 60 * 60;
  assert.ok(
    ttl <= expectedSeconds && ttl > expectedSeconds - 60,
    `expected TTL near ${expectedSeconds}s, got ${ttl}s`,
  );
});

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

test('PayPal verifyAndParseWebhook converts using the minorUnits snapshotted at checkout', async () => {
  const paypal = getProcessor('paypal');
  const orderId = uniqueId('ORDER');
  const accountId = uniqueId('acct');
  // A hypothetical 3-decimal currency: 1.234 major units = 1234 minor units.
  await store.set(`paypal-order:${orderId}`, {
    accountId,
    stroopsPerUnit: '10000000',
    usdPerUnit: '1',
    minorUnits: 1000,
    currency: 'usd',
  });
  const payload = JSON.stringify({
    id: uniqueId('evt'),
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: {
      custom_id: accountId,
      amount: { value: '1.234', currency_code: 'USD' },
      supplementary_data: { related_ids: { order_id: orderId } },
    },
  });
  const headers = {
    'paypal-transmission-id': 'tx-1',
    'paypal-transmission-time': '2024-01-01T00:00:00Z',
    'paypal-cert-url': 'https://api.paypal.com/cert.pem',
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-transmission-sig': 'valid-sig',
  };

  await withMockFetch(
    () => jsonResponse({ verification_status: 'SUCCESS' }),
    async () => {
      const event = await paypal.verifyAndParseWebhook(payload, headers);
      assert.equal(event.stroops, 10000000n * 1234n);
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

test('Coinbase verifyAndParseWebhook converts using the minorUnits snapshotted at checkout', async () => {
  const coinbase = getProcessor('coinbase');
  const chargeId = uniqueId('charge');
  const accountId = uniqueId('acct');
  await store.set(`coinbase-charge:${chargeId}`, {
    accountId,
    stroopsPerUnit: '10000000',
    usdPerUnit: '1',
    minorUnits: 1000,
    currency: 'usd',
  });
  const payload = JSON.stringify({
    id: uniqueId('evt'),
    event: {
      type: 'charge:confirmed',
      data: { id: chargeId, metadata: { accountId }, pricing: { local: { amount: '1.234', currency: 'USD' } } },
    },
  });
  const secret = config.billing.coinbaseCommerceWebhookSecret;
  const headers = { 'x-cc-webhook-signature': coinbaseSignature(payload, secret) };

  const event = await coinbase.verifyAndParseWebhook(payload, headers);
  assert.equal(event.stroops, 10000000n * 1234n);
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