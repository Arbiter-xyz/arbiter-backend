import { StrKey } from '@stellar/stellar-sdk';
import { getKnownJobIds, getJob } from './jobs.js';
import { getKnownWorkerIds, getReputation } from './dispatch.js';
import { getKnownPayerAddresses, getPayerQuestionIds, summarizePayerQuestions } from './payerIndex.js';
import { getKnownAnchorAddresses, getAnchorTransactions, getAnchorKyc } from './anchorRecords.js';
import { getStakeOnChain, getOwedOnChain } from './stellarClient.js';
import { getHorizon } from './sponsor.js';
import { config } from './config.js';
import { stroopsToUsdc } from './pricing.js';
import { unsuspendAccount } from './billing.js';

const PLATFORM_FEE_BPS = 2000n; // mirrors contracts/oracle-escrow/src/lib.rs's PLATFORM_FEE_BPS
const BPS_DENOM = 10_000n;

/** Durable, listable audit store for /admin/* actions. Follows jobs.js's
 * append-and-index pattern: one record per action plus a bounded index used
 * for listing. Kept in-memory here (same durability model as the rest of
 * this backend's stores) so an operator can query recent admin activity
 * rather than only the transient pino request line. */
const AUDIT_LOG_MAX = 1000;
const auditLog = [];

/** Records a single /admin/* call. Called for every admin route invocation,
 * including rejected (401/503) ones, so the log can't be gamed by a caller
 * who knows a call will fail. Emits a jobLogger()-style child log line for
 * live tailing and appends a durable record for the /admin/audit-log listing. */
export function recordAdminAction({ route, method, status, actor = 'shared-token' } = {}) {
  const entry = {
    timestamp: Date.now(),
    route,
    method,
    status,
    actor,
  };
  auditLog.push(entry);
  if (auditLog.length > AUDIT_LOG_MAX) auditLog.splice(0, auditLog.length - AUDIT_LOG_MAX);
  jobLogger({ route, method, status }).info('admin action');
  return entry;
}

/** Most-recent-first page of recorded /admin/* actions, following
 * listTransactions()'s limit/offset pagination shape. */
export async function listAuditLog({ limit = 50, offset = 0 } = {}) {
  const recent = auditLog.slice().reverse();
  return {
    total: recent.length,
    entries: recent.slice(offset, offset + limit),
  };
}

/** Most-recent-first page of every job this backend has ever created,
 * regardless of payer/worker — the admin analogue of the payer-scoped
 * /payers/:address/questions and worker-scoped leaderboard views. */
export async function listTransactions({ limit = DEFAULT_LIMIT, offset = 0 } = {}) {
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
 * roster, not just the ones good enough to rank publicly. Paginated like
 * listTransactions(): the id list is sliced *before* any per-item work, so
 * a page of N workers only issues on-chain reads for those N. */
export async function listWorkers({ limit = DEFAULT_LIMIT, offset = 0 } = {}) {
  const ids = await getKnownWorkerIds();
  return Promise.all(
    ids.map(async (workerId) => {
      const rep = await getReputation(workerId);
      const isAddress = StrKey.isValidEd25519PublicKey(workerId);
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
 * that payer about themselves (payerIndex.js's summarizePayerQuestions),
 * plus the loyalty tier that spend summary now qualifies them for. */
export async function listPayers() {
  const addresses = await getKnownPayerAddresses();
  return Promise.all(
    addresses.map(async (payerAddress) => {
      const ids = await getPayerQuestionIds(payerAddress);
      const jobs = await Promise.all(ids.map((id) => getJob(id)));
      const summary = summarizePayerQuestions(ids, jobs);
      const tier = evaluateLoyaltyTier(summary);
      return {
        payerAddress,
        totalTracked: summary.totalTracked,
        totalSpend: stroopsToUsdc(summary.totalSpendStroops),
        settled: summary.settled,
        successRate: summary.successRate,
        loyaltyTier: tier?.name ?? null,
      };
    }),
  );
}

/** Admin-only provisioning for enterprise customers who can't use a credit
 * card (issue #106): creates an account directly via createAccount(),
 * skipping createCheckoutSession() and any Stripe dependency entirely, then
 * credits its balance via store.incrBy() on the same credit:{accountId} key
 * handleStripeWebhook() uses — triggered here by an operator confirming a
 * wire/PO landed out-of-band rather than by a Stripe webhook firing.
 *
 * The raw API key is returned exactly once, in this response, mirroring
 * createCheckoutSession()'s one-time-reveal treatment (there it's embedded
 * in the checkout redirect URL; here there's no redirect to embed it in, so
 * it's returned directly). It is never persisted or logged in plaintext —
 * key recovery remains a deliberate v1 gap, same as the Stripe flow. */
export async function provisionAccount({ creditUsdc = 0 } = {}) {
  const account = await createAccount();
  const creditStroops = BigInt(Math.round(Number(creditUsdc) * 10_000_000));
  if (creditStroops > 0n) {
    await store.incrBy(`credit:${account.accountId}`, creditStroops);
  }
  return {
    accountId: account.accountId,
    apiKey: account.apiKey,
    credited: stroopsToUsdc(creditStroops),
  };
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
 * of that did settlement fees, specifically, account for."
 *
 * Deliberately a full-index aggregate: it must sum across every job to
 * report a total, so it can't be paginated. Its cost is bounded to
 * O(known jobs) *store* reads only — getJob() reads local job metadata and
 * makes no chain/RPC calls — so this stays cheap even at the 5,000-entry
 * index cap and needs no concurrency cap or memoization. */
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
 * their own transaction history from the anchor). Paginated like
 * listTransactions(): slice before per-item work. */
export async function listAnchorPayouts({ limit = DEFAULT_LIMIT, offset = 0 } = {}) {
  const addresses = await getKnownAnchorAddresses();
  const page = addresses.slice(offset, offset + limit);
  const rows = await mapWithConcurrency(page, MAX_CONCURRENCY, async (address) => {
    const txs = await getAnchorTransactions(address);
    return txs.filter((t) => t.kind === 'withdrawal').map((t) => ({ address, ...t }));
  });
  return {
    total: addresses.length,
    payouts: rows.flat().sort((a, b) => b.reportedAt - a.reportedAt),
  };
}

/** KYC & Tiers — self-reported SEP-12 customer status per address, same
 * caveat as listAnchorPayouts(). Paginated like listTransactions(): slice
 * before per-item work. */
export async function listAnchorKyc({ limit = DEFAULT_LIMIT, offset = 0 } = {}) {
  const addresses = await getKnownAnchorAddresses();
  const page = addresses.slice(offset, offset + limit);
  const rows = await mapWithConcurrency(page, MAX_CONCURRENCY, async (address) => {
    const kyc = await getAnchorKyc(address);
    return kyc ? { address, ...kyc } : null;
  });
  return { total: addresses.length, kyc: rows.filter(Boolean) };
}

/** Operator override for the anomaly auto-suspend (issue #153): clears the
 * suspension flag on an account so a wrongly-suspended key resumes
 * resolving. Gated behind requireAdmin at the route layer, same as every
 * other /admin/* handler. */
export async function unsuspendKey(accountId) {
  return unsuspendAccount(accountId);
}
