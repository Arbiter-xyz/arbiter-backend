import { getKnownJobIds, getJob } from './jobs.js';
import { getKnownWorkerIds, getReputation } from './dispatch.js';
import { getKnownPayerAddresses, getPayerQuestionIds, summarizePayerQuestions } from './payerIndex.js';
import { getKnownAnchorAddresses, getAnchorTransactions, getAnchorKyc } from './anchorRecords.js';
import { getStakeOnChain, getOwedOnChain } from './stellarClient.js';
import { getHorizon } from './sponsor.js';
import { config } from './config.js';
import { stroopsToUsdc } from './pricing.js';
import { getAuditLog } from './auditLog.js';

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

/**
 * Session recording/replay for admin console actions (#132).
 *
 * This is backend API-call recording, NOT full UI session replay: this repo
 * contains no admin console frontend to instrument, so there are no mouse
 * movements or rendered screens to capture. What we can own is the ordered
 * sequence of admin API calls taken during an incident, which is exactly
 * what #129's audit log already records — this extends that log with the
 * full (redacted) request context needed to reconstruct the sequence,
 * rather than introducing a second, parallel recording mechanism.
 *
 * Redaction is applied at write time by the audit log itself, using the
 * same REDACT_CONFIG that logger.js uses to strip Authorization/cookie
 * headers, so no sensitive header or body field is ever persisted here.
 *
 * Returns the recorded calls for one admin session as an ordered
 * (oldest-first) list, so an operator can replay the sequence of actions
 * that led up to a ticket. `sessionId` is the per-caller session identifier
 * attributed by #131's role-based admin permissions; when omitted, the
 * caller's own session is used.
 */
export async function getSessionRecording({ sessionId, limit = 200 } = {}) {
  const entries = await getAuditLog({ sessionId, limit });
  const calls = entries
    .filter((e) => e.sessionId === sessionId)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((e) => ({
      timestamp: e.timestamp,
      method: e.method,
      path: e.path,
      status: e.status,
      adminId: e.adminId ?? null,
      role: e.role ?? null,
      request: e.request ?? null,
      response: e.response ?? null,
    }));

  return {
    sessionId,
    // Explicitly documented so consumers don't mistake this for UI replay.
    kind: 'api-call-recording',
    note: 'Backend API-call sequence only; no admin frontend exists in this repo for UI-level replay.',
    total: calls.length,
    calls,
  };
}

/**
 * Explicit per-route role assignments for every /admin/* route.
 *
 * Every route today is read-only, so all are gated at `readonly` — a
 * read-only operator can call them, and a full-admin credential can too
 * (requireAdmin('readonly') accepts either role). Mutating admin routes
 * (e.g. #118 category CRUD, #123 review-queue approvals, #124 disputes)
 * must be registered here as `full` so a read-only credential is rejected
 * with 403 server-side, not merely hidden in a UI.
 *
 * `method` is the HTTP verb; `path` is the Express path as mounted under
 * /admin. Keeping this table explicit (rather than inferring from the
 * handler) is what makes the role assignment auditable per-route.
 */
export const ADMIN_ROUTE_ROLES = [
  { method: 'get', path: '/transactions', role: 'readonly', handler: listTransactions },
  { method: 'get', path: '/workers', role: 'readonly', handler: listWorkers },
  { method: 'get', path: '/payers', role: 'readonly', handler: listPayers },
  { method: 'get', path: '/treasury', role: 'readonly', handler: getTreasury },
  { method: 'get', path: '/fee-revenue', role: 'readonly', handler: getFeeRevenue },
  { method: 'get', path: '/anchor-payouts', role: 'readonly', handler: listAnchorPayouts },
  { method: 'get', path: '/anchor-kyc', role: 'readonly', handler: listAnchorKyc },
  { method: 'get', path: '/sessions/:sessionId/recording', role: 'readonly', handler: getSessionRecording },
];
