import { StrKey } from '@stellar/stellar-sdk';
import { store } from './store.js';

/**
 * Private worker pools: a payer-owned whitelist of worker addresses that
 * restricts which workers that payer's questions are dispatched to (see
 * dispatch.js's selectTargets() `whitelist` option and oracle.js's
 * fulfillOracleCall() for the enforcement half). One pool per Stellar
 * address — same identity model as everything else in this backend, no
 * org/team account system.
 *
 * Storage mirrors payerIndex.js: a per-owner list keyed by address
 * (private-pool:{payerAddress}), durable with no TTL (same choice as
 * reputation), plus a bounded index of every owner that has ever had a
 * pool so an admin view could enumerate them without a store-wide scan.
 *
 * Deliberately does NOT require an added address to already be a known
 * worker (getKnownWorkerIds()): that index only contains workers who have
 * had at least one outcome recorded, and a worker who is only ever
 * whitelisted can't earn an outcome until they're in the pool — requiring
 * it would make onboarding a brand-new team member impossible. Any
 * syntactically valid Stellar address can be pre-registered; it simply
 * receives nothing until it connects. Non-address test-string worker ids
 * are rejected: they carry no proof of identity (see workerAuth.js's
 * requiresAuth()), so whitelisting one would let anyone connect under that
 * name and receive the payer's private questions.
 */
const PREFIX = 'private-pool:';
export const MAX_POOL_SIZE = 500;

const POOL_OWNER_INDEX_KEY = 'known-private-pool-owners';
const MAX_TRACKED_POOL_OWNERS = 5_000;

export class PoolValidationError extends Error {}

export function isValidWorkerAddress(address) {
  return typeof address === 'string' && StrKey.isValidEd25519PublicKey(address);
}

function validateAddresses(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new PoolValidationError('workers must be a non-empty array of Stellar addresses');
  }
  const invalid = addresses.filter((a) => !isValidWorkerAddress(a));
  if (invalid.length > 0) {
    throw new PoolValidationError(`not valid Stellar addresses: ${invalid.map(String).join(', ')}`);
  }
}

export async function getKnownPoolOwners() {
  return (await store.get(POOL_OWNER_INDEX_KEY)) || [];
}

/** The payer's pool, or [] if they have none. An empty pool and no pool are
 * the same thing: removing the last worker deletes the key, so dispatch
 * falls back to the open pool rather than failing every question closed. */
export async function getPrivatePool(payerAddress) {
  if (!payerAddress) return [];
  return (await store.get(PREFIX + payerAddress)) || [];
}

/**
 * Adds addresses (de-duplicated, newest first). Rejects the whole call —
 * rather than silently truncating like the other bounded indexes do — if it
 * would exceed MAX_POOL_SIZE: quietly dropping a whitelisted worker would
 * change who a payer's questions reach without them knowing.
 */
export async function addPoolWorkers(payerAddress, addresses) {
  validateAddresses(addresses);
  const key = PREFIX + payerAddress;
  const existing = (await store.get(key)) || [];
  const additions = [...new Set(addresses)].filter((a) => !existing.includes(a));
  const next = [...additions, ...existing];
  if (next.length > MAX_POOL_SIZE) {
    throw new PoolValidationError(`a private pool can hold at most ${MAX_POOL_SIZE} workers`);
  }
  if (additions.length === 0) return existing;

  await store.set(key, next); // no TTL — durable, same choice as reputation

  const owners = await getKnownPoolOwners();
  if (!owners.includes(payerAddress)) {
    await store.set(POOL_OWNER_INDEX_KEY, [payerAddress, ...owners].slice(0, MAX_TRACKED_POOL_OWNERS));
  }
  return next;
}

export async function removePoolWorkers(payerAddress, addresses) {
  validateAddresses(addresses);
  const key = PREFIX + payerAddress;
  const existing = (await store.get(key)) || [];
  const removing = new Set(addresses);
  const next = existing.filter((a) => !removing.has(a));
  if (next.length === existing.length) return existing;

  if (next.length === 0) await store.delete(key);
  else await store.set(key, next);
  return next;
}
