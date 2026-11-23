import { logger } from './logger.js';
import { withTimeout } from './retry.js';
import {
  storeUp,
  storeDurable,
  chainRpcUp,
  chainLatestLedger,
  chainRpcProbeSeconds,
  onlineWorkers,
  probeErrorsTotal,
  recordJobScan,
  claudeBudgetSpentCents,
  claudeBudgetRemainingCents,
} from './metrics.js';

/**
 * Periodic probes that turn "is this dependency actually working right now"
 * into gauges Prometheus can alert on. A counter of failed requests only
 * moves when traffic arrives; a probe answers the question at 3am with zero
 * traffic too, which is exactly when a Redis or RPC outage would otherwise
 * go unnoticed until the first paid question fails to settle.
 *
 * Every probe takes its dependency as an argument so it's testable without
 * Redis or a chain; startHealthProbes() wires in the real ones.
 */

/** Redis: PING with a short timeout. The in-memory fallback is always "up"
 * but never durable — that combination is what the StoreNotDurable alert
 * keys on, since a silent fallback means the next restart loses all state. */
export async function probeStore(store, { timeoutMs = 2_000 } = {}) {
  const client = store.getClient();
  if (!client) {
    storeUp.set(1);
    storeDurable.set(0);
    return { up: true, durable: false };
  }
  storeDurable.set(1);
  try {
    await withTimeout(() => client.ping(), timeoutMs, 'store probe');
    storeUp.set(1);
    return { up: true, durable: true };
  } catch (err) {
    storeUp.set(0);
    probeErrorsTotal.inc({ probe: 'store' });
    logger.warn({ err }, 'store probe failed');
    return { up: false, durable: true, error: err.message };
  }
}

/** Soroban RPC: getLatestLedger. Also exports the sequence so a stalled
 * ledger (RPC answering but stuck) is alertable separately from "down". */
export async function probeChain(getLatestLedgerSequence, { timeoutMs = 5_000 } = {}) {
  const start = process.hrtime.bigint();
  try {
    const sequence = await withTimeout(() => getLatestLedgerSequence(), timeoutMs, 'chain probe');
    chainRpcUp.set(1);
    chainLatestLedger.set(Number(sequence));
    return { up: true, sequence: Number(sequence) };
  } catch (err) {
    chainRpcUp.set(0);
    probeErrorsTotal.inc({ probe: 'chain' });
    logger.warn({ err }, 'chain RPC probe failed');
    return { up: false, error: err.message };
  } finally {
    chainRpcProbeSeconds.set(Number(process.hrtime.bigint() - start) / 1e9);
  }
}

/** Walks the job index and publishes the in-flight counts and the oldest
 * in-flight job's age (the QuestionsStuckInFlight alert). Reads are issued
 * with bounded concurrency so a large index (up to MAX_TRACKED_JOBS) doesn't
 * serialize into a scan that outlasts the probe interval. */
export async function probeJobs({ getKnownJobIds, getJob }, now = Date.now(), { concurrency = 32 } = {}) {
  try {
    const ids = await getKnownJobIds();
    const jobs = new Array(ids.length);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const i = next++;
        jobs[i] = await getJob(ids[i]);
      }
    };
    const workers = [];
    const n = Math.min(concurrency, ids.length);
    for (let i = 0; i < n; i++) workers.push(worker());
    await Promise.all(workers);
    recordJobScan(jobs, now);
    return { scanned: ids.length };
  } catch (err) {
    probeErrorsTotal.inc({ probe: 'jobs' });
    logger.warn({ err }, 'job scan probe failed');
    return { error: err.message };
  }
}

/** Fleet-wide Claude spend cap (rateLimit.js): how much of the rolling
 * window's budget is spent and how much is left, so operators can alert
 * before the cap trips and real-Claude paths start falling back. Both values
 * are read from the shared store, so every instance reports the same
 * fleet-wide numbers. On a store error the last good values are kept rather
 * than zeroed, so a blip can't look like the budget just ran out. */
export async function probeClaudeBudget({ getSpent, getRemaining }) {
  try {
    const [spent, remaining] = await Promise.all([getSpent(), getRemaining()]);
    claudeBudgetSpentCents.set(spent);
    claudeBudgetRemainingCents.set(remaining);
    return { spent, remaining };
  } catch (err) {
    probeErrorsTotal.inc({ probe: 'claude_budget' });
    logger.warn({ err }, 'Claude budget probe failed');
    return { error: err.message };
  }
}

function every(intervalMs, fn) {
  const run = () => fn().catch((err) => logger.error({ err }, 'health probe threw'));
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}

/** Runs fn on an interval, skipping a tick if the previous run is still in
 * flight so a slow scan can't overlap itself and pile up concurrent scans. */
function everyNoOverlap(intervalMs, fn) {
  let running = false;
  const run = async () => {
    if (running) {
      logger.warn('health probe still running, skipping tick');
      return;
    }
    running = true;
    try {
      await fn();
    } catch (err) {
      logger.error({ err }, 'health probe threw');
    } finally {
      running = false;
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}

/**
 * Starts every probe on its own interval. The job scan reads every indexed
 * job (up to jobs.js's MAX_TRACKED_JOBS), so it runs less often than the
 * cheap single-call probes. Returns a stop() for tests and graceful shutdown.
 */
export function startHealthProbes({
  store,
  getLatestLedgerSequence,
  getKnownJobIds,
  getJob,
  getOnlineWorkerCount,
  getClaudeBudgetSpent,
  getClaudeBudgetRemaining,
  intervalMs = 15_000,
  jobScanIntervalMs = 60_000,
}) {
  const timers = [
    every(intervalMs, () => probeStore(store)),
    every(intervalMs, () => probeChain(getLatestLedgerSequence)),
    every(intervalMs, async () => onlineWorkers.set(await getOnlineWorkerCount())),
    // The job scan walks every indexed job and can take longer than
    // jobScanIntervalMs under a large index; everyNoOverlap() (not every())
    // skips a tick instead of starting a second scan on top of one still in
    // flight, so slow scans can't pile up concurrently.
    everyNoOverlap(jobScanIntervalMs, () => probeJobs({ getKnownJobIds, getJob })),
  ];
  // Optional so callers (and tests) that don't wire the budget readers keep
  // working; server.js always passes both.
  if (getClaudeBudgetSpent && getClaudeBudgetRemaining) {
    timers.push(
      every(intervalMs, () => probeClaudeBudget({ getSpent: getClaudeBudgetSpent, getRemaining: getClaudeBudgetRemaining })),
    );
  }
  return () => timers.forEach(clearInterval);
}
