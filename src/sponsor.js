import { Horizon, TransactionBuilder, Operation, Asset, BASE_FEE, Address, xdr, nativeToScVal } from '@stellar/stellar-sdk';
import { config } from './config.js';
import { getAdminKeypair, u64Arg, addressArg } from './stellarClient.js';
import { withRetry } from './retry.js';

// Horizon submission is safe to retry as a whole: a resubmission of the
// same already-signed transaction either succeeds once or comes back with
// a definitive rejection (e.g. tx_bad_seq if an earlier attempt actually
// landed) — Stellar's sequence-number model rules out a double-spend from
// retrying, the same reasoning stellarClient.js's invokeAsAdmin relies on.
const HORIZON_RETRY_OPTS = { attempts: 2, timeoutMs: 10_000, baseDelayMs: 300 };

let horizonServer = null;
function getHorizon() {
  if (!horizonServer) {
    horizonServer = new Horizon.Server(config.horizonUrl, { allowHttp: config.horizonUrl.startsWith('http://') });
  }
  return horizonServer;
}

function usdcAsset() {
  return new Asset(config.usdc.code, config.usdc.issuer);
}

/**
 * The standard Stellar "sponsored reserves" sandwich: the platform pays the
 * base reserve + fees for creating the worker's account and USDC trustline,
 * so a worker who has never held a stroop of XLM can still onboard. Returns
 * unsigned XDR for the worker to co-sign; the platform's own signature is
 * added in finalizeSponsoredOnboardTx.
 */
export async function buildSponsoredOnboardTx(workerAddress) {
  const admin = getAdminKeypair();
  const platformAccount = await withRetry(() => getHorizon().loadAccount(admin.publicKey()), {
    ...HORIZON_RETRY_OPTS,
    label: 'horizon.loadAccount',
  });

  const tx = new TransactionBuilder(platformAccount, { fee: BASE_FEE, networkPassphrase: config.networkPassphrase })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: workerAddress }))
    .addOperation(Operation.createAccount({ destination: workerAddress, startingBalance: '0' }))
    .addOperation(Operation.changeTrust({ asset: usdcAsset(), source: workerAddress }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: workerAddress }))
    .setTimeout(180)
    .build();

  return tx.toXDR();
}

export async function finalizeSponsoredOnboardTx(workerSignedXdr) {
  const admin = getAdminKeypair();
  const tx = TransactionBuilder.fromXDR(workerSignedXdr, config.networkPassphrase);
  tx.sign(admin);
  const res = await withRetry(() => getHorizon().submitTransaction(tx), {
    ...HORIZON_RETRY_OPTS,
    label: 'horizon.submitTransaction(onboard)',
  });
  return { hash: res.hash };
}

// ---------------------------------------------------------------------
// Fee-bump relay. Wraps an already-signed inner transaction (a payer's or
// worker's own contract call) in a Stellar fee-bump transaction funded by
// the platform key, so that account never needs to hold XLM for network
// fees. This is what lets payers pay for questions, and workers stake or
// withdraw, while holding zero XLM.
//
// CRITICAL SECURITY CHECK, shared by every relay below: assert the inner
// tx contains EXACTLY ONE invokeHostFunction operation whose invoked
// function (contract address + method name + args) byte-for-byte matches
// an expected call against our own contract id. We compare only the
// invoked-function bytes, not the whole operation — auth entries get
// populated during simulation in ways that can't be predicted ahead of
// time. The sole purpose of this check is to stop these endpoints being
// abused as an open fee relay for arbitrary transactions; real
// authorization is still enforced by the network at apply time (the inner
// tx must already carry the caller's own signature).
// ---------------------------------------------------------------------

function expectedHostFunctionBytes(functionName, args) {
  const invokeArgs = new xdr.InvokeContractArgs({
    contractAddress: new Address(config.contractId).toScAddress(),
    functionName,
    args,
  });
  return xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs).toXDR('raw');
}

function assertSingleMatchingInvocation(tx, label, functionName, args) {
  const ops = tx.operations;
  if (!ops || ops.length !== 1) {
    throw new Error(`${label}: expected exactly one operation in the submitted transaction`);
  }
  const op = ops[0];
  if (op.type !== 'invokeHostFunction') {
    throw new Error(`${label}: expected an invokeHostFunction operation`);
  }

  const actualBytes = op.func.toXDR('raw');
  const expectedBytes = expectedHostFunctionBytes(functionName, args);
  if (!actualBytes.equals(expectedBytes)) {
    throw new Error(`${label}: transaction does not match the expected ${functionName}() call for this contract`);
  }
}

async function relayFeeBump(signedInnerXdr, label, functionName, args) {
  const innerTx = TransactionBuilder.fromXDR(signedInnerXdr, config.networkPassphrase);
  // Deliberately OUTSIDE the retry below: a deterministic validation check
  // must fail once and immediately, not get retried against unchanged input.
  assertSingleMatchingInvocation(innerTx, label, functionName, args);

  const admin = getAdminKeypair();
  const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(admin, BASE_FEE, innerTx, config.networkPassphrase);
  feeBumpTx.sign(admin);

  const res = await withRetry(() => getHorizon().submitTransaction(feeBumpTx), {
    ...HORIZON_RETRY_OPTS,
    label: `horizon.submitTransaction(${label})`,
  });
  return { hash: res.hash };
}

/** Relays a payer's own submit(payer, questionId, amountStroops) call. */
export async function feeBumpSubmitPayment(signedInnerXdr, payerAddress, questionId, amountStroops) {
  return relayFeeBump(signedInnerXdr, 'sponsor/pay', 'submit', [
    addressArg(payerAddress),
    u64Arg(questionId),
    nativeToScVal(BigInt(amountStroops), { type: 'i128' }),
  ]);
}

/** Relays a worker's own stake(worker, amountStroops) call. */
export async function feeBumpStake(signedInnerXdr, workerAddress, amountStroops) {
  return relayFeeBump(signedInnerXdr, 'sponsor/stake', 'stake', [
    addressArg(workerAddress),
    nativeToScVal(BigInt(amountStroops), { type: 'i128' }),
  ]);
}

/** Relays a worker's own withdraw(worker) call. Funds always land on the
 * address embedded in the call itself, which the contract's require_auth
 * already ties to the caller's own signature — there is no separate
 * "expected amount" to check here, unlike submit()/stake(). */
export async function feeBumpWithdraw(signedInnerXdr, workerAddress) {
  return relayFeeBump(signedInnerXdr, 'sponsor/withdraw', 'withdraw', [addressArg(workerAddress)]);
}
