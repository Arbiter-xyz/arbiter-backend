import { getKnownJobIds, getJob } from './jobs.js';
import { getKnownWorkerIds, getReputation } from './dispatch.js';
import { getKnownPayerAddresses, getPayerQuestionIds, summarizePayerQuestions } from './payerIndex.js';
import { getKnownAnchorAddresses, getAnchorTransactions, getAnchorKyc } from './anchorRecords.js';
import { getStakeOnChain, getOwedOnChain } from './stellarClient.js';
import { getHorizon } from './sponsor.js';
import { config } from './config.js';
import { stroopsToUsdc } from './pricing.js';

const PLATFORM_FEE_BPS = 2000n; // mirrors contracts/oracle-escrow/src/lib.rs's PLATFORM_FEE_BPS
const BPS_DENOM = 10_000n;

/** Most-recent-first page of every job this backend has ever created,
 * regardless of payer/worker — the admin analogue of the payer-scoped
 * /payers/:address/questions and worker-scoped leaderboard views. */
export async function listTransactions({ limit = 50, offset = 0 } = {}) {
  const ids = await getKnownJobIds();
  const page = ids.slice(offset, offset + limit);
  const jobs = await Promise.all(page.map((id) => getJob(id)));
  return {
    total: ids.length,
    transactions: page.map((questionId, i) => ({ questionId, ...jobs[i] })).filter((t) => t.status),
  };
}

/** Every worker this backend has ever recorded an outcome for, with
 * reputation (off-chain) and stake/owed (read live from the contract) —
 * unlike leaderboard.js's getLeaderboard(), this deliberately includes
 * non-established workers too, since an operator needs to see the whole
 * roster, not just the ones good enough to rank publicly. */
export async function listWorkers() {
  const ids = await getKnownWorkerIds();
  return Promise.all(
    ids.map(async (workerId) => {
      const rep = await getReputation(workerId);
      const isAddress = workerId.startsWith('G') && workerId.length === 56;
      const [stakeStroops, owedStroops] = isAddress
        ? await Promise.all([getStakeOnChain(workerId).catch(() => 0n), getOwedOnChain(workerId).catch(() => 0n)])
        : [0n, 0n];
      return {
        workerId,
        totalAnswers: rep.total,
        matched: rep.matched,
        matchRatio: rep.total > 0 ? rep.matched / rep.total : null,
        established: rep.total >= config.worker.minAnswersBeforeReputationGate,
        stake: stroopsToUsdc(stakeStroops),
        owed: stroopsToUsdc(owedStroops),
      };
    }),
  );
}

/** Every payer address this backend has seen a verified on-chain payment
 * from, with the same spend/success aggregation the buyer dashboard shows
 * that payer about themselves (payerIndex.js's summarizePayerQuestions). */
export async function listPayers() {
  const addresses = await getKnownPayerAddresses();
  return Promise.all(
    addresses.map(async (payerAddress) => {
      const ids = await getPayerQuestionIds(payerAddress);
      const jobs = await Promise.all(ids.map((id) => getJob(id)));
      const summary = summarizePayerQuestions(ids, jobs);
      return {
        payerAddress,
        totalTracked: summary.totalTracked,
        totalSpend: stroopsToUsdc(summary.totalSpendStroops),
        settled: summary.settled,
        successRate: summary.successRate,
      };
    }),
  );
}

async function loadUsdcBalances(address) {
  const account = await getHorizon().loadAccount(address);
  const native = account.balances.find((b) => b.asset_type === 'native');
  const usdc = account.balances.find(
    (b) => b.asset_code === config.usdc.code && b.asset_issuer === config.usdc.issuer,
  );
  return { xlmBalance: native?.balance ?? '0', usdcBalance: usdc?.balance ?? '0' };
}

/** Live platform account balances via Horizon — the platform address is
 * where resolve() sends its PLATFORM_FEE_BPS cut directly (see lib.rs), so
 * this is a real, on-chain-verifiable treasury snapshot, not a number this
 * backend is asserting on its own authority. Also reports the separate
 * fiat-pool balance (billing.js's onramp), when configured — deliberately
 * a different address than platformAddress (see config.js's billing block
 * for why), so an operator needs both numbers to know the platform's full
 * on-chain position: this is the one place they're shown side by side. */
export async function getTreasury() {
  if (!config.platformAddress) return { configured: false };

  const platform = await loadUsdcBalances(config.platformAddress);
  const fiatPool = config.billing.fiatPoolAddress
    ? await loadUsdcBalances(config.billing.fiatPoolAddress).catch(() => null)
    : null;

  return {
    configured: true,
    platformAddress: config.platformAddress,
    xlmBalance: platform.xlmBalance,
    usdcBalance: platform.usdcBalance,
    fiatPool: fiatPool && {
      address: config.billing.fiatPoolAddress,
      xlmBalance: fiatPool.xlmBalance,
      usdcBalance: fiatPool.usdcBalance,
    },
  };
}

/** Sums the platform's PLATFORM_FEE_BPS cut across every settled+resolved
 * job this backend has recorded. A derived, historical figure (off-chain
 * bookkeeping over this backend's own job records) — the live treasury
 * balance above is the on-chain-verifiable ground truth; this is "how much
 * of that did settlement fees, specifically, account for." */
export async function getFeeRevenue() {
  const ids = await getKnownJobIds();
  const jobs = await Promise.all(ids.map((id) => getJob(id)));

  let totalFeeStroops = 0n;
  let resolvedCount = 0;
  for (const job of jobs) {
    if (job?.status !== 'settled' || job.outcome !== 'resolved') continue;
    totalFeeStroops += (BigInt(job.amountStroops || 0) * PLATFORM_FEE_BPS) / BPS_DENOM;
    resolvedCount += 1;
  }

  return {
    resolvedCount,
    totalFeeRevenue: stroopsToUsdc(totalFeeStroops),
  };
}

/** Bank Payouts — self-reported SEP-24 withdrawal history (see
 * anchorRecords.js for why this is a self-reported cache, not a live
 * per-address anchor query: SEP-10 means only the account holder can pull
 * their own transaction history from the anchor). */
export async function listAnchorPayouts() {
  const addresses = await getKnownAnchorAddresses();
  const rows = await Promise.all(
    addresses.map(async (address) => {
      const txs = await getAnchorTransactions(address);
      return txs.filter((t) => t.kind === 'withdrawal').map((t) => ({ address, ...t }));
    }),
  );
  return rows.flat().sort((a, b) => b.reportedAt - a.reportedAt);
}

/** KYC & Tiers — self-reported SEP-12 customer status per address, same
 * caveat as listAnchorPayouts(). */
export async function listAnchorKyc() {
  const addresses = await getKnownAnchorAddresses();
  const rows = await Promise.all(
    addresses.map(async (address) => {
      const kyc = await getAnchorKyc(address);
      return kyc ? { address, ...kyc } : null;
    }),
  );
  return rows.filter(Boolean);
}
