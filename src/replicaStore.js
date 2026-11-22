/**
 * Replica-aware, read-only store view for the admin console (#92).
 *
 * admin.js's list/summary endpoints each pull a whole index and then fan
 * out one read per record. On a busy deployment that competes with live
 * dispatch/settlement traffic on the same Redis. Pointing those reads at a
 * replica moves the load off the primary; every admin read tolerates
 * replica lag by construction, since admin.js never writes and nothing on
 * the settlement path reads through this.
 *
 * Failure model: a replica read that throws is retried on the primary, and
 * the replica is skipped for `retryAfterMs` before being tried again, so a
 * dead replica costs one failed round trip per window, not one per read,
 * and never takes down /admin/*. With no replica configured every read
 * goes straight to the primary, identical to importing `store` directly.
 *
 * Only read methods are exposed. There is deliberately no set/delete here:
 * a write sent to a replica is either rejected (READONLY) or silently lost
 * on the next resync, and neither should be possible from admin code.
 *
 * Kept free of config/ioredis imports so it's unit-testable on its own;
 * store.js does the wiring.
 */

const READ_METHODS = ['get', 'hgetall'];

export function createReplicaReadStore({ primary, replica = null, logger = null, retryAfterMs = 30_000, now = Date.now } = {}) {
  if (!primary) throw new Error('createReplicaReadStore: primary store is required');

  let replicaDownUntil = 0;
  let lastError = null;
  let lastSource = replica ? 'replica' : 'primary';

  function replicaUsable() {
    return Boolean(replica) && now() >= replicaDownUntil;
  }

  async function read(method, args) {
    if (replicaUsable()) {
      try {
        const value = await replica[method](...args);
        lastSource = 'replica';
        return value;
      } catch (err) {
        replicaDownUntil = now() + retryAfterMs;
        lastError = { message: err?.message || String(err), at: now() };
        logger?.warn?.({ err, retryAfterMs }, 'admin read replica failed — reading from primary');
      }
    }
    lastSource = 'primary';
    return primary[method](...args);
  }

  const view = {};
  for (const method of READ_METHODS) {
    view[method] = (...args) => read(method, args);
  }

  /**
   * Where admin reads are currently going, plus replication lag when the
   * replica's client can report it (INFO replication). Never throws: a
   * failed lag probe just reports lag as unknown.
   */
  view.status = async function status() {
    const base = {
      configured: Boolean(replica),
      source: replicaUsable() ? 'replica' : 'primary',
      lastSource,
      replicaDownUntil: replicaDownUntil > now() ? replicaDownUntil : null,
      lastError,
      lagSeconds: null,
      linkUp: null,
    };
    const client = replica?.getClient?.();
    if (!client?.info || !replicaUsable()) return base;
    try {
      const info = parseReplicationInfo(await client.info('replication'));
      return { ...base, lagSeconds: info.lastIoSecondsAgo, linkUp: info.linkUp, role: info.role };
    } catch {
      return base;
    }
  };

  return Object.freeze(view);
}

/**
 * Pure parser for Redis `INFO replication` output. On a replica,
 * master_last_io_seconds_ago is the closest built-in measure of how stale
 * its data might be; it's -1 (reported here as null) when the link is down.
 */
export function parseReplicationInfo(text) {
  const fields = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const lastIo = Number(fields.master_last_io_seconds_ago);
  return {
    role: fields.role || null,
    linkUp: fields.master_link_status ? fields.master_link_status === 'up' : null,
    lastIoSecondsAgo: Number.isFinite(lastIo) && lastIo >= 0 ? lastIo : null,
  };
}
