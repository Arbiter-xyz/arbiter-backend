import { store } from './store.js';

/**
 * Per-worker earnings and withdrawal ledger, bucketed by UTC calendar year.
 * The contract only keeps a running Owed balance per worker, not a history
 * of what was credited when, so an annual summary (taxReport.js) has to be
 * built from this backend's own record of every settlement it drove.
 *
 * Same caveat as admin.js's getFeeRevenue(): this is off-chain bookkeeping
 * over settlements this backend performed. Each credit carries the payout
 * transaction hash, so any line can be checked against the chain.
 *
 * Durable, no TTL: tax records have to outlive a job record's TTL by years.
 * Bucketing by year keeps each key bounded to one year's activity instead
 * of one list that grows forever.
 */

const CREDIT_PREFIX = 'earnings-credits:';
const WITHDRAWAL_PREFIX = 'earnings-withdrawals:';
const WORKER_YEARS_PREFIX = 'earnings-years:';
const EARNER_INDEX_PREFIX = 'earnings-workers:';

// Mirrors contracts/oracle-escrow/src/lib.rs's PLATFORM_FEE_BPS (same
// constant admin.js uses): resolve() sends this cut to the platform and
// splits the rest evenly across the matching workers.
const PLATFORM_FEE_BPS = 2000n;
const BPS_DENOM = 10_000n;

function yearOf(ts) {
  return new Date(ts).getUTCFullYear();
}

/** Each matching worker's share of a resolved question, with integer
 * division matching the contract's own i128 arithmetic (any remainder
 * stroop stays in the contract, never credited to a worker). */
export function workerShareStroops(amountStroops, matchingCount) {
  if (!matchingCount) return 0n;
  const net = BigInt(amountStroops) - (BigInt(amountStroops) * PLATFORM_FEE_BPS) / BPS_DENOM;
  return net / BigInt(matchingCount);
}

async function appendUnique(key, record, idField) {
  const existing = (await store.get(key)) || [];
  if (existing.some((r) => r[idField] === record[idField])) return false;
  await store.set(key, [...existing, record]);
  return true;
}

async function indexWorkerYear(workerId, year) {
  const yearsKey = WORKER_YEARS_PREFIX + workerId;
  const years = (await store.get(yearsKey)) || [];
  if (!years.includes(year)) await store.set(yearsKey, [...years, year].sort());

  const earnersKey = EARNER_INDEX_PREFIX + year;
  const earners = (await store.get(earnersKey)) || [];
  if (!earners.includes(workerId)) await store.set(earnersKey, [...earners, workerId]);
}

/** Records one credit per matching worker for a resolved question.
 * Idempotent per (worker, questionId), so a re-driven settlement can't
 * double-count. Can throw on a store failure; settlement callers must
 * .catch() it, since bookkeeping must never be what fails settlement. */
export async function recordWorkerCredits(questionId, matchingWorkerIds, amountStroops, payoutTx, creditedAt = Date.now()) {
  const share = workerShareStroops(amountStroops, matchingWorkerIds.length);
  if (share <= 0n) return;
  const year = yearOf(creditedAt);
  for (const workerId of matchingWorkerIds) {
    const added = await appendUnique(
      `${CREDIT_PREFIX}${workerId}:${year}`,
      {
        questionId: String(questionId),
        amountStroops: share.toString(),
        grossQuestionStroops: String(amountStroops),
        matchingWorkers: matchingWorkerIds.length,
        payoutTx: payoutTx || null,
        creditedAt,
      },
      'questionId',
    );
    if (added) await indexWorkerYear(workerId, year);
  }
}

/** Records a withdrawal the backend relayed. Not income (the income was
 * the credit), but a summary still shows it so a worker can reconcile
 * Owed against what actually reached their wallet. */
export async function recordWorkerWithdrawal(workerId, { amountStroops, txHash, beneficiaryAddress = null, auto = false }, withdrawnAt = Date.now()) {
  const year = yearOf(withdrawnAt);
  const added = await appendUnique(
    `${WITHDRAWAL_PREFIX}${workerId}:${year}`,
    {
      txHash,
      amountStroops: String(amountStroops),
      beneficiaryAddress,
      auto,
      withdrawnAt,
    },
    'txHash',
  );
  if (added) await indexWorkerYear(workerId, year);
}

export async function getWorkerCredits(workerId, year) {
  return (await store.get(`${CREDIT_PREFIX}${workerId}:${year}`)) || [];
}

export async function getWorkerWithdrawals(workerId, year) {
  return (await store.get(`${WITHDRAWAL_PREFIX}${workerId}:${year}`)) || [];
}

export async function getWorkerEarningYears(workerId) {
  return (await store.get(WORKER_YEARS_PREFIX + workerId)) || [];
}

/** Every worker with any credit or withdrawal recorded in `year` — what
 * the admin bulk export walks. */
export async function getEarnersForYear(year) {
  return (await store.get(EARNER_INDEX_PREFIX + year)) || [];
}
