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

const JOB_SCAN_BATCH_SIZE = 50;

/** Walks the job index in bounded concurrent batches and publishes the
 * in-flight counts and the oldest in-flight job's age (the QuestionsStuckInFlight alert). */
export async function probeJobs(
  { getKnownJobIds, getJob },
  now = Date.now(),
  { batchSize = JOB_SCAN_BATCH_SIZE } = {},
) {
  try {
    const ids = await getKnownJobIds();
    const step = Math.max(1, Math.floor(batchSize));
    const jobs = [];
    for (let i = 0; i < ids.length; i += step) {
      const batch = await Promise.all(ids.slice(i, i + step).map((id) => getJob(id)));
      jobs.push(...batch);
    }
    recordJobScan(jobs, now);
    return { scanned: ids.length };
  } catch (err) {
    probeErrorsTotal.inc({ probe: 'jobs' });
    logger.warn({ err }, 'job scan probe failed');
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
  intervalMs = 15_000,
  jobScanIntervalMs = 60_000,
}) {
  const timers = [
    every(intervalMs, () => probeStore(store)),
    every(intervalMs, () => probeChain(getLatestLedgerSequence)),
    every(intervalMs, async () => onlineWorkers.set(Number(await getOnlineWorkerCount()))),
    every(jobScanIntervalMs, () => probeJobs({ getKnownJobIds, getJob })),
  ];
  return () => timers.forEach(clearInterval);
}
