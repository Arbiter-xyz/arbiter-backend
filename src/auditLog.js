import { store } from './store.js';

/**
 * Durable, bounded append/read log used by support.js (#133) to record
 * ticket lifecycle events (opened, replied, closed) so an admin can audit
 * what happened to a support ticket without a store-wide scan.
 *
 * Mirrors payerIndex.js's durable-list pattern: a per-key list with no TTL
 * (durable, same choice as reputation) plus a bounded known-key index so
 * the set of logged subjects can be enumerated.
 */
const PREFIX = 'audit-log:';
const MAX_ENTRIES_PER_KEY = 500; // bound growth; keep the most recent

// Mirrors payerIndex.js's PAYER_INDEX_KEY: a durable, bounded list of every
// subject key ever logged, so an admin "Audit" view can enumerate them
// without a store-wide scan.
const AUDIT_INDEX_KEY = 'known-audit-keys';
const MAX_TRACKED_KEYS = 5_000;

export async function getKnownAuditKeys() {
  return (await store.get(AUDIT_INDEX_KEY)) || [];
}

/**
 * Append an entry to the log for `key`. Entries are stored newest-first and
 * bounded to MAX_ENTRIES_PER_KEY. The first write for a key also registers
 * it in the known-keys index.
 */
export async function appendAuditEntry(key, entry) {
  if (!key) return null;

  const storeKey = PREFIX + key;
  const existing = (await store.get(storeKey)) || [];
  const isNew = existing.length === 0;
  const record = { ...entry, at: entry?.at || new Date().toISOString() };
  const next = [record, ...existing].slice(0, MAX_ENTRIES_PER_KEY);
  await store.set(storeKey, next); // no TTL — durable, same choice as reputation

  if (isNew) {
    const known = await getKnownAuditKeys();
    if (!known.includes(key)) {
      await store.set(AUDIT_INDEX_KEY, [key, ...known].slice(0, MAX_TRACKED_KEYS));
    }
  }

  return record;
}

/**
 * Read the log for `key`, newest-first. Returns an empty array when nothing
 * has been logged yet.
 */
export async function readAuditLog(key) {
  if (!key) return [];
  return (await store.get(PREFIX + key)) || [];
}
