import { nextQuestionId, stashQuestion } from './pendingQuestions.js';
import { priceForTier, listTiersForClient, stroopsToUsdc } from './pricing.js';
import { getSmoothedOnlineWorkerCount } from './dispatch.js';
import { chargeBalance, getBalanceOnChain } from './stellarClient.js';
import { startFulfillment, consensusStashFields } from './oracle.js';
import { config } from './config.js';

/**
 * The prepaid-balance path: one deposit() (a real on-chain payer signature,
 * made once, out of band — see demo-agent) buys metered access afterward
 * with zero per-question signing. This mirrors issueChallenge()/
 * startFulfillment() from the normal pay-per-call flow almost exactly —
 * the only real difference is *how* the escrowed Question gets opened
 * (charge() drawing down a balance, vs. the payer calling submit()
 * themselves) — everything downstream (dispatch, reconcile, resolve/
 * refund) is the identical pipeline, unaware of which path funded it.
 *
 * `apiKeyAccountId` is set only for the API-key path, where `payerAddress`
 * is the platform's pooled fiat address rather than the caller's own — it
 * records who may cancel the job during the undo window (see cancelJob).
 *
 * Authentication is the caller's responsibility: `payerAddress` must have
 * already proven control of that address via the same challenge/response
 * session flow workerAuth.js uses for worker identity (see server.js's
 * route wiring) — without that, anyone could charge against a balance they
 * don't own just by naming someone else's address.
 */
export async function askMetered(payerAddress, questionText, tierKey, category, { ownerAccountId, consensusRule } = {}) {
  const questionId = (await nextQuestionId()).toString();
  const priced = priceForTier(tierKey, getSmoothedOnlineWorkerCount());

  // Throws (InsufficientBalance, or any RPC/network failure) if the charge
  // can't go through — no Question gets opened, no job gets created, so
  // there is nothing left dangling for the caller to clean up.
  await chargeBalance(payerAddress, questionId, priced.priceStroops);

  const pending = {
    question: questionText,
    tierKey: priced.key,
    priceStroops: priced.priceStroops.toString(),
    quorumSize: priced.quorumSize,
    timeoutMs: priced.timeoutMs,
    category: category || null,
    createdAt: Date.now(),
    ...consensusStashFields(consensusRule),
  };
  await stashQuestion(questionId, pending);

  const tier = { ...priced };
  const { jobId, cancellableUntil } = await startFulfillment(questionId, pending, tier, payerAddress, { ownerAccountId });

  return {
    jobId,
    ...(cancellableUntil ? { cancellableUntil, cancelUrl: `/oracle/${jobId}/cancel` } : {}),
    questionId,
    tier: priced.key,
    amount: stroopsToUsdc(priced.priceStroops),
    amountStroops: priced.priceStroops.toString(),
    tiers: listTiersForClient(),
  };
}

/**
 * Batch variant of askMetered(): asks N questions against the same prepaid
 * balance in one call. Each item is charged and opened through the exact
 * same per-question path as askMetered() (chargeBalance + stashQuestion +
 * startFulfillment), so the total charged is precisely the sum of each
 * item's individual surge-adjusted price — no separate batch pricing math.
 *
 * Semantics are partial-success: a malformed item (missing `question`) or a
 * per-item charge/fulfillment failure is reported in that item's slot with
 * its index, and the remaining items still proceed. This matches how
 * verifyPayment already reports per-question failure reasons rather than
 * failing the whole call.
 *
 * The caller (server.js) is responsible for counting the whole batch as a
 * single rate-limit consumption (config.rateLimits.oracleBatch) and for
 * capping the array size before calling in.
 */
export async function askMeteredBatch(payerAddress, items, { ownerAccountId } = {}) {
  const results = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item || typeof item.question !== 'string' || item.question.length === 0) {
      results.push({ index, ok: false, error: 'missing question' });
      continue;
    }
    if (item.question.length > config.maxQuestionLength) {
      results.push({ index, ok: false, error: 'question too long' });
      continue;
    }
    try {
      const result = await askMetered(payerAddress, item.question, item.tier, item.category, {
        ownerAccountId,
        consensusRule: item.consensusRule,
      });
      results.push({ index, ok: true, ...result });
    } catch (err) {
      results.push({ index, ok: false, error: err.message || 'charge failed' });
    }
  }
  return results;
}

export async function getMeteredBalance(payerAddress) {
  const stroops = await getBalanceOnChain(payerAddress);
  return { payerAddress, balanceStroops: stroops.toString(), balance: stroopsToUsdc(stroops) };
}

/** How the deposit itself is made — informational only, the backend never
 * holds or moves a payer's funds into the prepaid balance; deposit() takes
 * the payer's own signature directly, same as submit() always has.
 *
 * Returns structured fields (contractId, deposit/withdraw call shapes, the
 * session-token endpoint, and the ask endpoint) so clients can act on the
 * response programmatically instead of regexing prose. `instructions` is
 * kept as a human-readable summary for backward compatibility with any
 * existing consumer that renders it verbatim. */
export function depositInstructions(payerAddress) {
  const contractId = config.contractId;
  const sessionTokenEndpoint = `/payers/${payerAddress}/session`;
  const askEndpoint = '/oracle';
  return {
    payerAddress,
    contractId,
    deposit: {
      contractId,
      function: 'deposit',
      args: [payerAddress, '<amount>'],
    },
    withdraw: {
      contractId,
      function: 'withdraw_balance',
      args: [payerAddress, '<amount>'],
    },
    sessionTokenEndpoint,
    askEndpoint,
    askFields: ['payerAddress', 'sessionToken'],
    instructions:
      `Call deposit(${payerAddress}, <amount>) directly on contract ${contractId} to fund a ` +
      'prepaid balance, then include payerAddress + a session token (from ' +
      `POST ${sessionTokenEndpoint}) in a normal POST ${askEndpoint} call to ask questions against ` +
      'it with no further signatures — same endpoint as the classic pay-per-call flow, just ' +
      `with those two extra fields. Call withdraw_balance(${payerAddress}, <amount>) at any ` +
      'time to reclaim unused funds.',
  };
}
