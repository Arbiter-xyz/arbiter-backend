import { randomUUID } from 'node:crypto';
import { store } from './store.js';

/**
 * Admin action audit trail (#129). A durable, bounded, newest-first list,
 * using the same pattern as payerIndex.js's known-address index. Callers
 * treat this as best-effort (each call site wraps it in .catch(() => {})):
 * losing an audit entry is bad, but it must never make the admin action
 * itself fail.
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
  const existing = (await store.get(AUDIT_LOG_KEY)) || [];
  await store.set(AUDIT_LOG_KEY, [entry, ...existing].slice(0, MAX_TRACKED_ENTRIES));
  return entry;
}

/** Most recent entries first, optionally filtered by actor. */
export async function listAuditLog({ actor, limit = 200 } = {}) {
  const entries = (await store.get(AUDIT_LOG_KEY)) || [];
  const filtered = actor ? entries.filter((e) => e.actor === actor) : entries;
  return filtered.slice(0, limit);
}
