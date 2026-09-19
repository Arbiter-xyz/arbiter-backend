import './helpers/billing-test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import {
  reserveCredit,
  settleReservation,
  getCreditBalanceStroops,
  handleStripeWebhook,
  isAllowedRedirectUrl,
  createCheckoutSession,
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
