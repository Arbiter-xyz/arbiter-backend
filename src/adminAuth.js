import { config } from './config.js';

/**
 * Gate for every /admin/* route. Deliberately a single shared bearer
 * token, not a session/account system — see config.js's `admin` block for
 * why. Refuses every request (rather than failing open) when ADMIN_TOKEN
 * is unset, so an operator can't accidentally ship this surface wide open
 * by forgetting to configure it.
 */
export function requireAdmin(req, res, next) {
  if (!config.admin.token) {
    return res.status(503).json({ error: 'admin console not configured (ADMIN_TOKEN unset)' });
  }

  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || token !== config.admin.token) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  next();
}

/**
 * Admin-only provisioning of an invoice/PO-billed account (#106).
 *
 * Enterprise customers paying by purchase order or wire transfer have no
 * card, so the self-serve `createCheckoutSession()` flow (and its Stripe
 * `isBillingConfigured()` gate) doesn't apply to them. This handler lets an
 * operator confirm an out-of-band payment and provision credit directly:
 *
 *   1. `createAccount()` mints the account + API key, skipping Stripe.
 *   2. `store.incrBy()` credits `credit:{accountId}` — the same primitive
 *      `handleStripeWebhook()` uses, just triggered by an operator instead
 *      of a webhook.
 *
 * The raw API key is returned exactly once in this response (there is no
 * checkout redirect to embed it in). It is never persisted or logged in
 * plaintext — key recovery remains a deliberate v1 gap, mirroring
 * `createCheckoutSession()`'s existing one-time-reveal comment.
 *
 * Downstream, a manually-provisioned account is indistinguishable from a
 * Stripe-funded one: POST /oracle still goes through the same
 * reserveCredit()/settleReservation() path with no special-casing.
 *
 * Structured accounts-receivable tracking (invoice number, due date,
 * payment status) is explicitly out of scope for this primitive.
 */
export function createInvoiceBilledAccount({ createAccount, store }) {
  return async function provisionInvoiceBilledAccount(req, res) {
    const { amount } = req.body || {};
    const credit = Number(amount);
    if (!Number.isFinite(credit) || credit <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number of credits' });
    }

    const account = await createAccount();
    await store.incrBy(`credit:${account.accountId}`, credit);

    // One-time reveal: the raw key is returned here and nowhere else.
    return res.status(201).json({
      accountId: account.accountId,
      apiKey: account.apiKey,
      credited: credit,
      billing: 'invoice',
    });
  };
}
