import { StrKey } from '@stellar/stellar-sdk';
import { getKnownWorkerIds, getReputation } from './dispatch.js';
import { getStakeOnChain } from './stellarClient.js';
import { config } from './config.js';
import { stroopsToUsdc } from './pricing.js';
import { store } from './store.js';

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

/**
 * Short-TTL cache for the computed leaderboard, keyed by limit. Match
 * ratios shift as questions resolve, so the window is seconds, not
 * minutes: a leaderboard response reflects match-ratio changes within
 * LEADERBOARD_CACHE_TTL_MS (default 10s). The cache lives in store.js so
 * RedisStore instances share it across processes rather than each
 * instance re-simulating getStakeOnChain() independently. Any store
 * failure (e.g. Redis briefly unreachable) degrades to the uncached path
 * rather than surfacing a 500.
 */
export const LEADERBOARD_CACHE_TTL_MS = 10_000;

function leaderboardCacheKey(limit) {
  return `leaderboard:${limit}`;
}

export async function getLeaderboard(limit = 50) {
  const cacheKey = leaderboardCacheKey(limit);

  try {
    const cached = await store.get(cacheKey);
    if (cached) return cached;
  } catch {
    // Cache backend unavailable — fall through to the uncached computation.
  }

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

  const ranked = rankLeaderboard(rows, limit);

  try {
    await store.set(cacheKey, ranked, LEADERBOARD_CACHE_TTL_MS);
  } catch {
    // Cache write failure is non-fatal; the response is still correct.
  }

  return ranked;
}

