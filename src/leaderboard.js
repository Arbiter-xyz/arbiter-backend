import { StrKey } from '@stellar/stellar-sdk';
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
      const isAddress = StrKey.isValidEd25519PublicKey(workerId);
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

/**
 * v2 leaderboard shape (issue #136's worked example of explicit version
 * negotiation). The v1 rows above are left byte-for-byte unchanged so the
 * existing route test suite keeps passing; v2 is purely additive and
 * reshapes the same underlying data into a self-describing envelope with
 * an explicit `apiVersion` marker and a stable `rank` field, which is the
 * kind of change that would otherwise be a silent breaking change for any
 * integrator parsing positional array order.
 *
 * `matchRatio` is emitted as a rounded percentage (0-100) rather than the
 * raw 0-1 float, and `stake` is nested under a `stake` object alongside
 * its raw stroops value so a consumer never has to guess units. Workers
 * with no answers yet keep `matchRatio: null` rather than being coerced to
 * 0, which would misrepresent "no data" as "zero accuracy".
 */
export function toLeaderboardV2(rows) {
  return {
    apiVersion: 'v2',
    workers: rows.map((r, i) => ({
      rank: i + 1,
      workerId: r.workerId,
      totalAnswers: r.totalAnswers,
      matched: r.matched,
      matchRatioPct: r.matchRatio === null ? null : Math.round(r.matchRatio * 100),
      stake: {
        stroops: r.stakeStroops,
        usdc: r.stake,
      },
      established: r.established,
    })),
  };
}

export async function getLeaderboardV2(limit = 50) {
  return toLeaderboardV2(await getLeaderboard(limit));
}
