import { randomUUID } from 'node:crypto';

/**
 * Canary deployment safety (#89).
 *
 * The hazard: stellarClient.js's createSerialQueue() serializes platform-key
 * transactions within ONE process. Two processes signing resolve()/refund()
 * from the same PLATFORM_SECRET at once both read the same account sequence
 * and one transaction fails — the race cf60fc4 fixed, reintroduced the
 * moment a second instance (a canary) comes up. Three pieces close it:
 *
 *  1. Instance role. A 'canary' never signs as the platform key at all
 *     (createSignerLock().run() refuses before building a transaction), and
 *     createReadOnlyGate() limits it to read-only paths, so it can take a
 *     percentage of GET /leaderboard and GET /stats with zero settlement
 *     risk. It holds no SSE workers and dispatches nothing, so every
 *     in-flight quorum lives on the primary.
 *  2. A cross-instance signer lock. Every platform-key transaction runs
 *     under a short setNX lease in the shared store, so even two primaries
 *     (old and new, overlapping during promotion) serialize their signing
 *     fleet-wide. The lease is per call, not held for the process lifetime,
 *     so several primaries can all settle their own questions — just never
 *     at the same moment.
 *  3. Drain on shutdown. createDrainController() tracks in-flight
 *     fulfillments; on SIGTERM the instance stops taking new questions and
 *     keeps running until they settle, so a promotion or rollback never
 *     abandons a job in awaiting_workers.
 *
 * Kept free of config/SDK imports so it's unit-testable on its own.
 */

export const SIGNER_LOCK_KEY = 'lock:platform-signer';

// Identifies this process in signer-lock tokens and in GET /health, so the
// preflight can tell whether two URLs really reach two different instances.
export const INSTANCE_ID = randomUUID();

export class SignerLockError extends Error {
  constructor(message) {
    super(message);
    this.status = 503;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Compare-and-delete, so an instance whose lease already expired can never
// release a lease another instance has since acquired. RedisStore JSON-
// encodes values, hence comparing against the JSON form of the token.
const RELEASE_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
  return 0
`;

export function createSignerLock({
  store,
  role = 'primary',
  key = SIGNER_LOCK_KEY,
  ttlMs = 60_000,
  waitMs = 90_000,
  pollMs = 250,
  instanceId = INSTANCE_ID,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  if (!store) throw new Error('createSignerLock: store is required');

  async function acquire() {
    const deadline = now() + waitMs;
    for (;;) {
      const token = `${instanceId}:${randomUUID()}`;
      if (await store.setNX(key, token, ttlMs)) return token;
      if (now() >= deadline) {
        throw new SignerLockError(`timed out after ${waitMs}ms waiting for another instance's platform signer lock`);
      }
      await sleep(pollMs);
    }
  }

  async function release(token) {
    const client = store.getClient?.();
    if (client?.eval) {
      await client.eval(RELEASE_SCRIPT, 1, key, JSON.stringify(token));
      return;
    }
    // MemoryStore: single process, so get-then-delete can't race another instance.
    if ((await store.get(key)) === token) await store.delete(key);
  }

  /** Runs `fn` while holding the fleet-wide signer lock. */
  async function run(fn) {
    if (role === 'canary') {
      throw new SignerLockError('this instance is a canary (INSTANCE_ROLE=canary) and never signs as the platform key');
    }
    const token = await acquire();
    try {
      return await fn();
    } finally {
      await release(token).catch(() => {}); // a failed release just waits out the TTL
    }
  }

  return Object.freeze({ run, instanceId, role });
}

/**
 * Express middleware: on a canary, only GET/HEAD for `readPaths` get
 * through. Everything else is a 503 with Retry-After, which a traffic
 * splitter can route to the primary and which a client retry will
 * (probabilistically) land on the primary anyway. A no-op on a primary.
 */
export function createReadOnlyGate({ role, readPaths = [] }) {
  const allowed = new Set(readPaths);
  return function readOnlyGate(req, res, next) {
    if (role !== 'canary') return next();
    if ((req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') && allowed.has(req.path)) return next();
    res.set('Retry-After', '1');
    res.set('X-Arbiter-Instance-Role', 'canary');
    return res.status(503).json({ error: 'this instance is a read-only canary; retry against the primary' });
  };
}

/**
 * Tracks in-flight fulfillments so shutdown can wait for them. `track()`
 * takes the promise for one question's dispatch → reconcile → settle run.
 */
export function createDrainController({ sleep = defaultSleep, now = Date.now, pollMs = 500 } = {}) {
  let inFlight = 0;
  let draining = false;

  function track(promise) {
    inFlight += 1;
    const done = () => {
      inFlight -= 1;
    };
    promise.then(done, done);
    return promise;
  }

  /**
   * Waits until nothing is in flight or `timeoutMs` passes. `minWaitMs`
   * covers work not yet tracked, e.g. a question sitting in its undo-window
   * hold that will start fulfillment moments from now.
   */
  async function waitForIdle({ timeoutMs, minWaitMs = 0 }) {
    const start = now();
    const deadline = start + timeoutMs;
    while (now() < deadline) {
      if (inFlight === 0 && now() - start >= minWaitMs) return { drained: true, inFlight: 0 };
      await sleep(pollMs);
    }
    return { drained: inFlight === 0, inFlight };
  }

  return Object.freeze({
    track,
    waitForIdle,
    beginDrain: () => {
      draining = true;
    },
    isDraining: () => draining,
    inFlightCount: () => inFlight,
  });
}

/**
 * What an operator compares before promoting a canary: both instances must
 * point at the same contract, platform account and network, and share a
 * reachable Redis (otherwise the signer lock, dispatch state and job records
 * aren't actually shared). Pure, so the preflight script and tests agree.
 */
export function deploymentFingerprint({ config, instanceId, storeKind, storeReachable }) {
  return {
    role: config.canary?.role ?? 'primary',
    instanceId,
    contractId: config.contractId || null,
    contractIds: (config.contracts || []).map((c) => c.id),
    platformAddress: config.platformAddress || null,
    networkPassphrase: config.networkPassphrase,
    compatibleContractVersion: config.compatibleContractVersion || null,
    store: storeKind,
    storeReachable,
  };
}

const MUST_MATCH = ['contractId', 'contractIds', 'platformAddress', 'networkPassphrase', 'compatibleContractVersion'];

/**
 * Compares two deploymentFingerprint()s (from each instance's GET /health).
 * Returns a list of human-readable problems; empty means safe to promote.
 */
export function comparePreflight(primary, canary) {
  const problems = [];
  if (!primary) return ['primary /health did not report a deployment fingerprint'];
  if (!canary) return ['canary /health did not report a deployment fingerprint'];

  for (const field of MUST_MATCH) {
    if (JSON.stringify(primary[field] ?? null) !== JSON.stringify(canary[field] ?? null)) {
      problems.push(`${field} differs: primary=${JSON.stringify(primary[field])} canary=${JSON.stringify(canary[field])}`);
    }
  }
  if (!canary.contractId) problems.push('canary has no ORACLE_CONTRACT_ID');
  if (!canary.platformAddress) problems.push('canary has no PLATFORM_ADDRESS');
  for (const [name, fp] of [['primary', primary], ['canary', canary]]) {
    if (fp.store !== 'redis') problems.push(`${name} is not using Redis (store=${fp.store}) — state and the signer lock would not be shared`);
    else if (!fp.storeReachable) problems.push(`${name} cannot reach Redis`);
  }
  if (primary.instanceId && primary.instanceId === canary.instanceId) {
    problems.push('both URLs answered from the same instance — the canary URL is not reaching the canary');
  }
  return problems;
}
