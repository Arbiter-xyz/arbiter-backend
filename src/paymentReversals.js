import { store } from './store.js';

/**
 * Durable record of Stripe payment reversals (refunds/disputes) per fiat
 * API-key account, so the admin console can see which accounts have had a
 * payment clawed back. Same bounded, durable index pattern as
 * anchorRecords.js / payerIndex.js.
 */

const REVERSAL_PREFIX = 'payment-reversals:';
const ACCOUNT_INDEX_KEY = 'known-reversal-accounts';
const MAX_TRACKED_PER_ACCOUNT = 50;
const MAX_TRACKED_ACCOUNTS = 5_000;

export async function recordPaymentReversal(accountId, record) {
  const key = REVERSAL_PREFIX + accountId;
  const existing = (await store.get(key)) || [];
  await store.set(key, [{ ...record, recordedAt: Date.now() }, ...existing].slice(0, MAX_TRACKED_PER_ACCOUNT));

  const known = (await store.get(ACCOUNT_INDEX_KEY)) || [];
  if (!known.includes(accountId)) {
    await store.set(ACCOUNT_INDEX_KEY, [accountId, ...known].slice(0, MAX_TRACKED_ACCOUNTS));
  }
}

export async function getPaymentReversals(accountId) {
  return (await store.get(REVERSAL_PREFIX + accountId)) || [];
}

export async function listPaymentReversals() {
  const accountIds = (await store.get(ACCOUNT_INDEX_KEY)) || [];
  return Promise.all(accountIds.map(async (accountId) => ({ accountId, reversals: await getPaymentReversals(accountId) })));
}
