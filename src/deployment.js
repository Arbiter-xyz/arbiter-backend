/**
 * Blue-green deployment support (#90): a single-writer lease over the admin
 * key, and a graceful drain.
 *
 * Why a lease at all: every resolve()/refund() is signed by ONE platform key
 * with a strictly increasing sequence number (see stellarClient.js's serial
 * admin queue). That queue serializes calls within one process; it can't
 * stop a second process — the "green" deployment standing by next to
 * "blue" — from signing at the same moment. So while both run, exactly one
 * holds write authority: the holder of a lease in the shared store, which
 * is checked inside the serial queue immediately before every admin call is
 * built and signed. A non-holder's settlement WAITS for the lease (it is
 * not dropped), so a job green picks up just after cutover settles a few
 * seconds late instead of being stranded.
 *
 * Handoff is atomic from the admin key's perspective: blue drains (stops
 * taking new questions, finishes in-flight ones), then releases; green
 * acquires on its next admin call. If blue dies instead, its lease expires
 * after ttlMs and green acquires automatically. The incident-only
 * `forceTakeover()` skips the drain and accepts that an admin call already
 * mid-flight on blue may overlap — the contract's QuestionNotPending
 * rejection is what keeps that from ever becoming a double payout.
 *
 * Everything here takes its store/clock/hooks as arguments, so the
 * cutover sequences are testable without Redis, a chain, or a server
 * (test/deployment.test.js).
 */

export const WRITER_LEASE_KEY = 'deploy:admin-writer-lease';

export class LeaseUnavailableError extends Error {
  constructor(holder, waitedMs) {
    super(
      `admin write lease is held by ${holder?.instanceId ?? 'another instance'}; ` +
        `gave up after ${waitedMs}ms (is the other environment still draining?)`,
    );
    this.code = 'ADMIN_WRITE_LEASE_UNAVAILABLE';
    this.holder = holder;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Store-backed single-writer lease. Uses only primitives every store
 * implements: setNX for the atomic first claim, get/set/delete for
 * holder-only renew and release.
 *
 * Renewal is check-then-set, so it can't atomically fence against a lease
 * that expired between the check and the set. The renew interval is ttl/3,
 * so that window requires this process to stall for two-thirds of the TTL
 * mid-renewal — and the contract-level QuestionNotPending rejection remains
 * the backstop even then.
 */
export function createWriterLease({ store, instanceId, ttlMs = 30_000, now = Date.now }) {
  if (!instanceId) throw new Error('createWriterLease requires an instanceId');
  let renewTimer = null;

  const record = () => ({ instanceId, acquiredAt: now() });
  const isMine = (holder) => Boolean(holder && holder.instanceId === instanceId);

  const lease = {
    instanceId,
    ttlMs,

    async holder() {
      return (await store.get(WRITER_LEASE_KEY)) || null;
    },

    /** True if this instance holds the lease after the call (claimed, or
     * already held and renewed). */
    async tryAcquire() {
      if (await store.setNX(WRITER_LEASE_KEY, record(), ttlMs)) return true;
      return lease.renew();
    },

    /** Extends the lease if, and only if, this instance holds it. */
    async renew() {
      const current = await lease.holder();
      if (!isMine(current)) return false;
      await store.set(WRITER_LEASE_KEY, current, ttlMs);
      return true;
    },

    /** Gives the lease up (end of a drain). No-op if someone else holds it. */
    async release() {
      const current = await lease.holder();
      if (!isMine(current)) return false;
      await store.delete(WRITER_LEASE_KEY);
      return true;
    },

    /** Incident-only instant swap: claim the lease regardless of holder. */
    async forceTakeover() {
      const previous = await lease.holder();
      await store.set(WRITER_LEASE_KEY, record(), ttlMs);
      return { previous };
    },

    async waitForLease({ timeoutMs = 90_000, pollMs = 500 } = {}) {
      const started = now();
      for (;;) {
        if (await lease.tryAcquire()) return true;
        const waited = now() - started;
        if (waited >= timeoutMs) throw new LeaseUnavailableError(await lease.holder(), waited);
        await sleep(pollMs);
      }
    },

    startRenewing(intervalMs = Math.floor(ttlMs / 3)) {
      if (renewTimer) return;
      renewTimer = setInterval(() => {
        lease.renew().catch(() => {});
      }, intervalMs);
      renewTimer.unref?.();
    },

    stopRenewing() {
      if (renewTimer) clearInterval(renewTimer);
      renewTimer = null;
    },
  };
  return lease;
}

/**
 * The function stellarClient.js runs before every admin call (see
 * setAdminWriteGuard there): returns once this instance holds the lease,
 * waiting up to `waitMs` for another environment's drain to finish, and
 * throws LeaseUnavailableError past that so the caller's normal
 * fail-closed path (refund / recovery sweep) takes over.
 */
export function createAdminWriteGuard(lease, { waitMs = 90_000, pollMs = 500 } = {}) {
  return async function ensureAdminWriter() {
    if (await lease.tryAcquire()) return;
    await lease.waitForLease({ timeoutMs: waitMs, pollMs });
  };
}

/**
 * Graceful drain. `countInFlight()` returns how many jobs THIS instance is
 * still responsible for (their quorum collectors and undo-window timers are
 * process-local, so they can't be handed to the other environment
 * mid-flight). Hooks:
 *  - onDrainStart: stop accepting work that would outlive the drain
 *    (background sweeps) — new questions are already refused by
 *    rejectWhileDraining the moment drain() is called.
 *  - onDrained: runs once in-flight reaches zero OR the timeout passes —
 *    this is where the lease is released, so cutover always proceeds.
 *  - onResume: undo onDrainStart (rollback to this instance).
 *
 * On timeout, the jobs still in flight are reported as `stranded`, not
 * silently abandoned: their escrow is on-chain, so the recovery sweep
 * (disasterRecovery.js) or the contract's permissionless refund_timeout()
 * refunds them — the same backstop as a crash, just named in the report.
 */
export function createDrainController({
  countInFlight,
  onDrainStart = [],
  onDrained = [],
  onResume = [],
  timeoutMs = 60_000,
  pollMs = 500,
  retryAfterSeconds = 5,
  now = Date.now,
  log = null,
}) {
  let state = 'serving';
  let startedAt = null;
  let report = null;
  let pending = null;

  async function runHooks(hooks) {
    for (const hook of hooks) {
      try {
        await hook();
      } catch (err) {
        log?.error?.({ err }, '[deploy] drain hook failed');
      }
    }
  }

  async function run() {
    await runHooks(onDrainStart);
    let inFlight = await countInFlight();
    while (inFlight > 0 && now() - startedAt < timeoutMs) {
      await sleep(pollMs);
      inFlight = await countInFlight();
    }
    await runHooks(onDrained);
    state = 'drained';
    report = { drained: inFlight === 0, stranded: inFlight, durationMs: now() - startedAt };
    log?.info?.(report, '[deploy] drain complete');
    return report;
  }

  return {
    get state() {
      return state;
    },

    isDraining() {
      return state !== 'serving';
    },

    /** Idempotent: concurrent/repeat calls share one drain. */
    drain() {
      if (!pending) {
        state = 'draining';
        startedAt = now();
        log?.info?.({ timeoutMs }, '[deploy] draining: refusing new questions, finishing in-flight jobs');
        pending = run();
      }
      return pending;
    },

    /** Rollback: put a drained (or draining) instance back into service. */
    async resume() {
      if (state === 'serving') return false;
      if (pending) await pending;
      pending = null;
      report = null;
      state = 'serving';
      await runHooks(onResume);
      log?.info?.('[deploy] resumed serving');
      return true;
    },

    async status() {
      return { state, startedAt, inFlight: await countInFlight(), report };
    },

    /** Express middleware for routes that create new work (POST /oracle…). */
    rejectWhileDraining(req, res, next) {
      if (state === 'serving') return next();
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(503).json({ error: 'this instance is draining for a deploy; retry shortly', state });
    },

    /** GET /health/ready — what the platform's health check / router should
     * poll: 503 as soon as a drain starts, so traffic moves off first. */
    readinessHandler(req, res) {
      if (state === 'serving') return res.json({ ready: true });
      return res.status(503).json({ ready: false, state });
    },
  };
}

// Statuses whose collectors/timers live in the process that created them.
// `scheduled` is deliberately absent: a scheduled job is portable — any
// instance's scheduling sweep dispatches it when it comes due.
export const PROCESS_BOUND_STATUSES = new Set(['holding', 'awaiting_workers', 'reconciling', 'cancelling']);

/** countInFlight() over the durable job index: jobs this instance created
 * that haven't reached a terminal/portable state. */
export function createInFlightCounter({ getKnownJobIds, getJob, instanceId }) {
  return async function countInFlight() {
    let count = 0;
    for (const jobId of await getKnownJobIds()) {
      const job = await getJob(jobId);
      if (job && job.instanceId === instanceId && PROCESS_BOUND_STATUSES.has(job.status)) count += 1;
    }
    return count;
  };
}

/**
 * Admin control surface, gated by `adminGate`:
 * - GET  /admin/deploy/status
 * - POST /admin/deploy/drain[?wait=true]   start (or join) a drain
 * - POST /admin/deploy/resume              rollback onto this instance
 * - POST /admin/deploy/takeover            INCIDENT ONLY: seize the writer lease without a drain
 */
export function mountDeployRoutes(app, adminGate, { drain, lease = null }) {
  async function status() {
    const holder = lease ? await lease.holder() : null;
    return {
      instanceId: lease?.instanceId ?? null,
      ...(await drain.status()),
      writerLease: lease ? { enabled: true, holder, held: holder?.instanceId === lease.instanceId } : { enabled: false },
    };
  }

  app.get('/admin/deploy/status', adminGate, async (req, res) => res.json(await status()));

  app.post('/admin/deploy/drain', adminGate, async (req, res) => {
    const running = drain.drain();
    if (req.query.wait === 'true') await running;
    res.status(req.query.wait === 'true' ? 200 : 202).json(await status());
  });

  app.post('/admin/deploy/resume', adminGate, async (req, res) => {
    const resumed = await drain.resume();
    res.json({ resumed, ...(await status()) });
  });

  app.post('/admin/deploy/takeover', adminGate, async (req, res) => {
    if (!lease) return res.status(409).json({ error: 'writer lease is disabled (DEPLOY_WRITER_LEASE is not true)' });
    const { previous } = await lease.forceTakeover();
    req.log?.warn({ previous }, '[deploy] writer lease force-taken over');
    res.json({ previous, ...(await status()) });
  });
}
