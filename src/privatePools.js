import { StrKey } from '@stellar/stellar-sdk';
import { store } from './store.js';

const PREFIX = 'private-pool:';
export const MAX_POOL_SIZE = 500;

const POOL_OWNER_INDEX_KEY = 'known-private-pool-owners';
const MAX_TRACKED_POOL_OWNERS = 5_000;

export class PoolValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PoolValidationError';
  }
}

function isAddress(value) {
  return typeof value === 'string' && StrKey.isValidEd25519PublicKey(value);
}

function validateAddresses(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new PoolValidationError('addresses must be a non-empty array');
  }
  for (const a of addresses) {
    if (!isAddress(a)) throw new PoolValidationError(`invalid address: ${a}`);
  }
}

async function recordPoolOwner(payerAddress) {
  const owners = (await store.get(POOL_OWNER_INDEX_KEY)) || [];
  if (owners.includes(payerAddress)) return;
  owners.push(payerAddress);
  while (owners.length > MAX_TRACKED_POOL_OWNERS) owners.shift();
  await store.set(POOL_OWNER_INDEX_KEY, owners);
}

async function forgetPoolOwner(payerAddress) {
  const owners = (await store.get(POOL_OWNER_INDEX_KEY)) || [];
  const next = owners.filter((o) => o !== payerAddress);
  if (next.length === owners.length) return;
  await store.set(POOL_OWNER_INDEX_KEY, next);
}

export async function getKnownPoolOwners() {
  return (await store.get(POOL_OWNER_INDEX_KEY)) || [];
}

export async function getPrivatePool(payerAddress) {
  if (!isAddress(payerAddress)) return [];
  return (await store.get(PREFIX + payerAddress)) || [];
}

export async function addPoolWorkers(payerAddress, addresses) {
  validateAddresses(addresses);
  const key = PREFIX + payerAddress;
  const existing = (await store.get(key)) || [];
  const merged = [...existing];
  for (const a of addresses) {
    const idx = merged.indexOf(a);
    if (idx !== -1) merged.splice(idx, 1);
    merged.unshift(a);
  }
  if (merged.length > MAX_POOL_SIZE) {
    throw new PoolValidationError(`a pool may hold at most ${MAX_POOL_SIZE} workers`);
  }
  await store.set(key, merged);
  await recordPoolOwner(payerAddress);
  return merged;
}

export async function removePoolWorkers(payerAddress, addresses) {
  validateAddresses(addresses);
  const key = PREFIX + payerAddress;
  const existing = (await store.get(key)) || [];
  const removing = new Set(addresses);
  const next = existing.filter((a) => !removing.has(a));
  if (next.length === existing.length) return existing;

  if (next.length === 0) {
    await store.delete(key);
    await forgetPoolOwner(payerAddress);
  } else {
    await store.set(key, next);
  }
  return next;
}
