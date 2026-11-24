import { randomUUID } from 'node:crypto';
import { store } from './store.js';

/**
 * Admin action audit trail (#129). A durable, bounded, newest-first list,
 * using the same pattern as payerIndex.js's known-address index. Callers
 * treat this as best-effort (each call site wraps it in .catch(() => {})):
 * losing an audit entry is bad, but it must never make the admin action
 * itself fail.
 *
 * Appends use an atomic list push + trim (#520) so concurrent admin actions
 * cannot lose entries via a read-modify-write race, and each append no longer
 * rewrites the whole array.
 */

const AUDIT_LOG_KEY = 'audit-log';
const MAX_TRACKED_ENTRIES = 5_000;

export async function appendAuditLog({ action, actor, target = null, metadata = null }) {
  const entry = {
    id: randomUUID(),
    action,
    actor,
    target,
    metadata,
    at: new Date().toISOString(),
  };
  await store.listPush(AUDIT_LOG_KEY, entry, MAX_TRACKED_ENTRIES);
  return entry;
}

/** Most recent entries first, optionally filtered by actor. */
export async function listAuditLog({ actor, limit = 200 } = {}) {
  const entries = (await store.listRange(AUDIT_LOG_KEY, 0, -1)) || [];
  const filtered = actor ? entries.filter((e) => e.actor === actor) : entries;
  return filtered.slice(0, limit);
}

export async function _resetAuditLogForTesting() {
  if (typeof store.delete === 'function') {
    await store.delete(AUDIT_LOG_KEY);
  } else {
    await store.set(AUDIT_LOG_KEY, []);
  }
}