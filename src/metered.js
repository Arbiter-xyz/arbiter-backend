import { nextQuestionId, stashQuestion } from './pendingQuestions.js';
import { priceForTier, listTiersForClient, stroopsToUsdc } from './pricing.js';
import { getSmoothedOnlineWorkerCount } from './dispatch.js';
import { chargeBalance, getBalanceOnChain } from './stellarClient.js';
import { startFulfillment } from './oracle.js';
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
 * Authentication is the caller's responsibility: `payerAddress` must have
 * already proven control of that address via the same challenge/response
 * session flow workerAuth.js uses for worker identity (see server.js's
 * route wiring) — without that, anyone could charge against a balance they
 * don't own just by naming someone else's address.
 */
export async function askMetered(payerAddress, questionText, tierKey, category) {
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
  };
  await stashQuestion(questionId, pending);

  const tier = { ...priced };
  const { jobId } = await startFulfillment(questionId, pending, tier);

  return {
    jobId,
    questionId,
    tier: priced.key,
    amount: stroopsToUsdc(priced.priceStroops),
    tiers: listTiersForClient(),
  };
}

export async function getMeteredBalance(payerAddress) {
  const stroops = await getBalanceOnChain(payerAddress);
  return { payerAddress, balanceStroops: stroops.toString(), balance: stroopsToUsdc(stroops) };
}

/** How the deposit itself is made — informational only, the backend never
 * holds or moves a payer's funds into the prepaid balance; deposit() takes
 * the payer's own signature directly, same as submit() always has. */
export function depositInstructions(payerAddress) {
  return {
    payerAddress,
    instructions:
      `Call deposit(${payerAddress}, <amount>) directly on contract ${config.contractId} to fund a ` +
      'prepaid balance, then include payerAddress + a session token (from ' +
      'POST /payers/:address/session) in a normal POST /oracle call to ask questions against ' +
      'it with no further signatures — same endpoint as the classic pay-per-call flow, just ' +
      `with those two extra fields. Call withdraw_balance(${payerAddress}, <amount>) at any ` +
      'time to reclaim unused funds.',
  };
}
