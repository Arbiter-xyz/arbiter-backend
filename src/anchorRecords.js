import { store } from './store.js';

/**
 * Self-reported cache of anchor activity, keyed by the Stellar address that
 * observed it. NOT a live query against the anchor — see anchorClient.js
 * for why the backend has no authority to ask an anchor about an address
 * other than by that address's own SEP-10 token. The frontend drives SEP-10
 * + SEP-24 directly against the anchor for its own connected wallet, then
 * reports the outcome here (session-token authed — see the /anchor/report
 * route in server.js) purely so the admin console has something to show.
 * Treat every record here as "what this user's own browser told us," not
 * ground truth independently verified by this backend.
 */

const TX_PREFIX = 'anchor-tx:';
const KYC_PREFIX = 'anchor-kyc:';
const MAX_TRACKED_PER_ADDRESS = 50;

// Same bounded, durable index pattern as jobs.js / payerIndex.js / dispatch.js.
const ADDRESS_INDEX_KEY = 'known-anchor-addresses';
const MAX_TRACKED_ADDRESSES = 5_000;

async function indexAddress(address) {
  const known = (await store.get(ADDRESS_INDEX_KEY)) || [];
  if (known.includes(address)) return;
  await store.set(ADDRESS_INDEX_KEY, [address, ...known].slice(0, MAX_TRACKED_ADDRESSES));
}

export async function getKnownAnchorAddresses() {
  return (await store.get(ADDRESS_INDEX_KEY)) || [];
}

export async function recordAnchorTransaction(address, { kind, status, amount, assetCode, anchorTransactionId }) {
  if (kind !== 'deposit' && kind !== 'withdrawal') {
    throw new Error(`unknown anchor transaction kind: ${kind}`);
  }
  const key = TX_PREFIX + address;
  const existing = (await store.get(key)) || [];
  const record = { kind, status, amount, assetCode, anchorTransactionId, reportedAt: Date.now() };
  // Replace an existing report for the same anchor transaction id (status
  // moves e.g. pending_user_transfer_start -> completed) rather than
  // accumulating duplicate rows for one real transaction.
  const next = [record, ...existing.filter((r) => r.anchorTransactionId !== anchorTransactionId)].slice(
    0,
    MAX_TRACKED_PER_ADDRESS,
  );
  await store.set(key, next); // no TTL — durable, same choice as reputation/payer indexes
  await indexAddress(address);
}

export async function getAnchorTransactions(address) {
  return (await store.get(TX_PREFIX + address)) || [];
}

export async function recordAnchorKyc(address, { status, tier }) {
  await store.set(KYC_PREFIX + address, { status, tier, reportedAt: Date.now() });
  await indexAddress(address);
}

export async function getAnchorKyc(address) {
  return store.get(KYC_PREFIX + address);
}
