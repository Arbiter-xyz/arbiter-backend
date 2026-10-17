import { StrKey } from '@stellar/stellar-sdk';
import { store } from './store.js';
import { getKnownJobIds, getJob } from './jobs.js';
import { getKnownWorkerIds, getReputation, getWorkerConnectedAt } from './dispatch.js';
import { getKnownPayerAddresses, getPayerQuestionIds, summarizePayerQuestions, evaluateLoyaltyTier } from './payerIndex.js';
import { getKnownAnchorAddresses, getAnchorTransactions, getAnchorKyc } from './anchorRecords.js';
import { getStakeOnChain, getOwedOnChain } from './stellarClient.js';
import { getHorizon } from './sponsor.js';
import { config } from './config.js';
import { stroopsToUsdc } from './pricing.js';
import { getClient } from './reconcile.js';
import { createAccount, unsuspendAccount } from './billing.js';
import { getWorkerCollusionReport } from './collusion.js';

export const DEFAULT_LIMIT = 50;
export const MAX_CONCURRENCY = 10;

const PLATFORM_FEE_BPS = 2000n; // mirrors contracts/oracle-escrow/src/lib.rs's PLATFORM_FEE_BPS
const BPS_DENOM = 10_000n;

export async function mapWithConcurrency(items, concurrency, fn) {
  const list = Array.from(items || []);
  const limit = Math.max(1, Number(concurrency) || MAX_CONCURRENCY);
  const results = new Array(list.length);
  let cursor = 0;

  async function worker() {
    while (cursor < list.length) {
      const idx = cursor++;
      results[idx] = await fn(list[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, () => worker()));
  return results;
}

/**
 * Pure composite worker fraud/risk scorer (issue #122).
 * Combines 4 signals into a 0..100 risk score:
 *  - reputationMismatch: high wrong-answer rate once the worker has answered questions
 *  - collusionScore: highest pairwise collusion heuristic score (0..1)
 *  - lowStake: whether on-chain stake is below the minimum required stake
 *  - newAccountBurst: high answer volume shortly after first connection
 */
export function computeFraudScore({
  totalAnswers = 0,
  matched = 0,
  maxCollusionScore = 0,
  collusionSuspended = false,
  stakeStroops = 0n,
  minStakeStroops = BigInt(config.worker?.minStakeStroops || 0),
  connectedAt = null,
  now = Date.now(),
} = {}) {
  const matchRatio = totalAnswers > 0 ? matched / totalAnswers : 1;
  const mismatchRate = totalAnswers > 0 ? Math.max(0, 1 - matchRatio) : 0;
  // Weight mismatch more heavily once the worker has enough answers to judge
  const confidenceWeight = Math.min(1, totalAnswers / Math.max(1, config.worker?.minAnswersBeforeReputationGate || 5));
  const reputationComponent = mismatchRate * confidenceWeight * 45;

  const normalizedCollusion = Math.max(0, Math.min(1, Number(maxCollusionScore) || 0));
  const collusionComponent = Math.max(normalizedCollusion * 35, collusionSuspended ? 35 : 0);

  const stakeBig = typeof stakeStroops === 'bigint' ? stakeStroops : BigInt(stakeStroops || 0);
  const minStakeBig = typeof minStakeStroops === 'bigint' ? minStakeStroops : BigInt(minStakeStroops || 0);
  const stakeComponent = minStakeBig > 0n && stakeBig < minStakeBig
    ? Number(((minStakeBig - stakeBig) * 1000n) / minStakeBig) / 1000 * 10
    : 0;

  let burstComponent = 0;
  if (connectedAt != null && now > connectedAt) {
    const ageHours = Math.max((now - connectedAt) / (60 * 60 * 1000), 1 / 60);
    const answersPerHour = totalAnswers / ageHours;
    if (answersPerHour > 30 && mismatchRate > 0.3) {
      burstComponent = Math.min(10, ((answersPerHour - 30) / 70) * 10);
    }
  }

  const rawScore = Math.round(reputationComponent + collusionComponent + stakeComponent + burstComponent);
  const score = Math.max(0, Math.min(100, rawScore));
  const level = score >= 70 ? 'high' : score >= 35 ? 'medium' : 'low';

  return {
    score,
    level,
    signals: {
      mismatchRate: Number(mismatchRate.toFixed(4)),
      maxCollusionScore: Number(normalizedCollusion.toFixed(4)),
      collusionSuspended: Boolean(collusionSuspended),
      underStaked: minStakeBig > 0n && stakeBig < minStakeBig,
      burstScore: Number(burstComponent.toFixed(2)),
    },
  };
}

/**
 * Live fraud/risk report for a single worker address/ID (issue #122),
 * surfaced at GET /admin/workers/:address/risk and embedded on listWorkers().
 */
export async function getFraudScore(workerId) {
  const [rep, collusion, connectedAt] = await Promise.all([
    getReputation(workerId),
    getWorkerCollusionReport(workerId, getReputation).catch(() => ({ suspended: null, pairs: [] })),
    Promise.resolve(getWorkerConnectedAt(workerId)),
  ]);
  const isAddress = StrKey.isValidEd25519PublicKey(workerId);
  const stakeStroops = isAddress ? await getStakeOnChain(workerId).catch(() => 0n) : 0n;
  const maxCollusionScore = (collusion?.pairs || []).reduce((max, p) => Math.max(max, p.score || 0), 0);

  const assessment = computeFraudScore({
    totalAnswers: rep.total,
    matched: rep.matched,
    maxCollusionScore,
    collusionSuspended: Boolean(collusion?.suspended),
    stakeStroops,
    connectedAt,
  });

  return {
    workerId,
    totalAnswers: rep.total,
    matched: rep.matched,
    matchRatio: rep.total > 0 ? rep.matched / rep.total : null,
    stake: stroopsToUsdc(stakeStroops),
    connectedAt,
    ...assessment,
  };
}

/** Tool-forced Claude call, structurally modeled on reconcile.js's
 * REPORT_CONSENSUS_TOOL / reconcileWithClaude() pattern: a single tool whose
 * input_schema is the postmortem's structured shape, forced via tool_choice
 * so the model can only answer by filling that schema in. */
export const REPORT_POSTMORTEM_TOOL = {
  name: 'report_postmortem',
  description:
    'Draft a structured incident postmortem from a set of correlated log lines.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One-paragraph incident summary.' },
      timeline: {
        type: 'array',
        description: 'Ordered incident timeline derived from the log lines.',
        items: {
          type: 'object',
          properties: {
            at: { type: 'string', description: 'Timestamp or log position of the event.' },
            event: { type: 'string', description: 'What happened at this point.' },
          },
          required: ['at', 'event'],
        },
      },
      rootCause: { type: 'string', description: 'Best-supported root cause, or "unknown".' },
      affectedJobs: {
        type: 'array',
        description: 'Job ids implicated in the incident.',
        items: { type: 'string' },
      },
    },
    required: ['summary', 'timeline', 'rootCause', 'affectedJobs'],
  },
};

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
  const page = ids.slice(offset, offset + limit);
  return mapWithConcurrency(page, MAX_CONCURRENCY, async (workerId) => {
    const [rep, collusion, connectedAt] = await Promise.all([
      getReputation(workerId),
      getWorkerCollusionReport(workerId, getReputation).catch(() => ({ suspended: null, pairs: [] })),
      Promise.resolve(getWorkerConnectedAt(workerId)),
    ]);
    const isAddress = StrKey.isValidEd25519PublicKey(workerId);
    const [stakeStroops, owedStroops] = isAddress
      ? await Promise.all([getStakeOnChain(workerId).catch(() => 0n), getOwedOnChain(workerId).catch(() => 0n)])
      : [0n, 0n];
    const maxCollusionScore = (collusion?.pairs || []).reduce((max, p) => Math.max(max, p.score || 0), 0);
    const fraud = computeFraudScore({
      totalAnswers: rep.total,
      matched: rep.matched,
      maxCollusionScore,
      collusionSuspended: Boolean(collusion?.suspended),
      stakeStroops,
      connectedAt,
    });
    return {
      workerId,
      totalAnswers: rep.total,
      matched: rep.matched,
      matchRatio: rep.total > 0 ? rep.matched / rep.total : null,
      established: rep.total >= config.worker.minAnswersBeforeReputationGate,
      stake: stroopsToUsdc(stakeStroops),
      owed: stroopsToUsdc(owedStroops),
      fraudScore: fraud.score,
      fraudLevel: fraud.level,
    };
  });
}

/** Every payer address this backend has seen a verified on-chain payment
 * from, with the same spend/success aggregation the buyer dashboard shows
 * that payer about themselves (payerIndex.js's summarizePayerQuestions),
 * plus the loyalty tier that spend summary now qualifies them for. */
export async function listPayers({ limit = DEFAULT_LIMIT, offset = 0 } = {}) {
  const addresses = await getKnownPayerAddresses();
  const page = addresses.slice(offset, offset + limit);
  return mapWithConcurrency(page, MAX_CONCURRENCY, async (payerAddress) => {
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
  });
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
    await store.incrBy(`credit:${account.accountId}`, Number(creditStroops));
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
  const payouts = rows.flat().sort((a, b) => b.reportedAt - a.reportedAt);
  Object.defineProperties(payouts, {
    total: { value: addresses.length, enumerable: false },
    payouts: { value: payouts, enumerable: false },
  });
  return payouts;
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
  const kyc = rows.filter(Boolean);
  Object.defineProperties(kyc, {
    total: { value: addresses.length, enumerable: false },
    kyc: { value: kyc, enumerable: false },
    customers: { value: kyc, enumerable: false },
  });
  return kyc;
}

/** Operator override for the anomaly auto-suspend (issue #153): clears the
 * suspension flag on an account so a wrongly-suspended key resumes
 * resolving. Gated behind requireAdmin at the route layer, same as every
 * other /admin/* handler. */
export async function unsuspendKey(accountId) {
  return unsuspendAccount(accountId);
}

/** Filters a slice of structured JSON log lines down to the ones correlated
 * with an incident: an optional [from, to] time range and/or a job id. Log
 * lines are the pino JSON objects logger.js already emits (request-id /
 * job-id correlation fields), so this is a pure, unit-testable filter over
 * a canned sample — no log-aggregator integration required. */
export function selectIncidentLogs(logs, { from, to, jobId } = {}) {
  return (logs || []).filter((line) => {
    if (jobId && line.jobId !== jobId && line['job-id'] !== jobId) return false;
    const at = line.time ?? line.timestamp;
    if (from && at != null && at < from) return false;
    if (to && at != null && at > to) return false;
    return true;
  });
}

/** Turns a set of correlated log lines into a structured postmortem draft
 * via a tool-forced Claude call, modeled on reconcile.js's
 * reconcileWithClaude(). Never throws: on any Claude failure (missing key,
 * timeout, malformed tool output) it resolves to a clearly-marked fallback
 * so an operator always gets a response and the process never sees an
 * unhandled rejection. */
export async function generatePostmortem(logs, { from, to, jobId } = {}) {
  const selected = selectIncidentLogs(logs, { from, to, jobId });
  const fallback = {
    generated: false,
    error: 'draft generation failed, see raw logs',
    logCount: selected.length,
    logs: selected,
  };

  let client;
  try {
    client = getClient();
  } catch {
    return fallback;
  }
  if (!client) return fallback;

  try {
    const message = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 2048,
      tools: [REPORT_POSTMORTEM_TOOL],
      tool_choice: { type: 'tool', name: REPORT_POSTMORTEM_TOOL.name },
      messages: [
        {
          role: 'user',
          content:
            'Draft an incident postmortem from these correlated log lines. ' +
            'Use only what the logs support; mark anything uncertain as unknown.\n\n' +
            JSON.stringify(selected),
        },
      ],
    });

    const toolUse = (message.content || []).find(
      (block) => block.type === 'tool_use' && block.name === REPORT_POSTMORTEM_TOOL.name,
    );
    if (!toolUse?.input) return fallback;

    return { generated: true, logCount: selected.length, ...toolUse.input };
  } catch {
    return fallback;
  }
}
