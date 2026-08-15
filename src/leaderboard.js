import { getKnownWorkerIds, getReputation } from './dispatch.js';
import { getStakeOnChain } from './stellarClient.js';
import { config } from './config.js';
import { stroopsToUsdc } from './pricing.js';

/**
 * Worker reputation is already used internally to gate routing (see
 * dispatch.js's isEligible/isEstablishedWorker), but that score lives
 * behind this backend and nowhere a buyer — or the worker themselves —
 * can see it independent of trusting this API's word for it. This makes
 * the same underlying data public and cross-checkable: match ratio comes
 * from this backend's own outcome records (not independently verifiable
 * on-chain, stated plainly rather than overclaimed), but stake is read
 * live from the contract itself, so at least that portion of any given
 * row can be verified by any third party without asking this backend
 * anything at all.
 *
 * Deliberately does NOT include a slash-history field: the contract emits
 * no queryable slash log today, and fabricating one from off-chain guesses
 * would be worse than omitting it. A real slash-history column needs an
 * events indexer, which is a genuine follow-up, not something to fake here.
 */
/**
 * Established workers only, ranked by accuracy then sample size — a fresh
 * worker's first lucky answer shouldn't outrank a long, real track record.
 * Non-established workers still exist in the index (and are answering
 * questions right now) but don't yet have a large enough sample to rank
 * meaningfully; surfacing them here would reward exactly the sybil-quorum
 * pattern isEstablishedWorker already guards against elsewhere in this
 * system. Pure and synchronous so it's testable without touching the store
 * or the chain — see getLeaderboard() for the async data-gathering side.
 */
export function rankLeaderboard(rows, limit = 50) {
  return rows
    .filter((r) => r.established)
    .sort((a, b) => b.matchRatio - a.matchRatio || b.totalAnswers - a.totalAnswers)
    .slice(0, limit);
}

export async function getLeaderboard(limit = 50) {
  const ids = await getKnownWorkerIds();

  const rows = await Promise.all(
    ids.map(async (workerId) => {
      const rep = await getReputation(workerId);
      const isAddress = workerId.startsWith('G') && workerId.length === 56;
      const stakeStroops = isAddress ? await getStakeOnChain(workerId).catch(() => 0n) : 0n;
      return {
        workerId,
        totalAnswers: rep.total,
        matched: rep.matched,
        matchRatio: rep.total > 0 ? rep.matched / rep.total : null,
        stakeStroops: stakeStroops.toString(),
        stake: stroopsToUsdc(stakeStroops),
        established: rep.total >= config.worker.minAnswersBeforeReputationGate,
      };
    }),
  );

  return rankLeaderboard(rows, limit);
}
