import { Keypair, TransactionBuilder, Contract, Account, Address, nativeToScVal, scValToNative, rpc } from '@stellar/stellar-sdk';
import { config } from './config.js';
import { withRetry } from './retry.js';

let server = null;
export function getServer() {
  if (!server) {
    server = new rpc.Server(config.sorobanRpcUrl, { allowHttp: config.sorobanRpcUrl.startsWith('http://') });
  }
  return server;
}

let adminKeypair = null;
export function getAdminKeypair() {
  if (!config.platformSecret) throw new Error('PLATFORM_SECRET not configured');
  if (!adminKeypair) adminKeypair = Keypair.fromSecret(config.platformSecret);
  return adminKeypair;
}

export function u64Arg(value) {
  return nativeToScVal(BigInt(value), { type: 'u64' });
}

export function i128Arg(value) {
  return nativeToScVal(BigInt(value), { type: 'i128' });
}

export function addressArg(address) {
  return new Address(address).toScVal();
}

export function vecOfAddresses(addresses) {
  return nativeToScVal(
    addresses.map((a) => new Address(a)),
    { type: 'Vec' },
  );
}

/** Builds, prepares (simulates + assembles auth/footprint), signs as the
 * platform admin, submits, and polls a contract call. Used ONLY for
 * resolve()/refund() — the backend never signs on behalf of a payer or
 * worker.
 *
 * Retried as a whole (not just the send step): each attempt re-fetches a
 * fresh account/sequence number and rebuilds the transaction from scratch,
 * so retrying the full flow is safe — there's no risk of resubmitting a
 * stale, already-consumed sequence number. A double-send of the same
 * *logical* call is also safe at the contract level: resolve()/refund()
 * both reject a non-Pending question, so a retry that lands after an
 * earlier attempt actually succeeded just fails harmlessly with
 * QuestionNotPending instead of double-settling anything. Bounded to 2
 * attempts / 10s each — this sits in the critical path of settling a
 * question, so it must fail fast enough to still hit the fail-closed
 * refund fallback promptly, not retry indefinitely.
 */
async function invokeAsAdmin(method, scValArgs) {
  return withRetry(
    async () => {
      const srv = getServer();
      const admin = getAdminKeypair();
      const account = await srv.getAccount(admin.publicKey());
      const contract = new Contract(config.contractId);

      const tx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase: config.networkPassphrase })
        .addOperation(contract.call(method, ...scValArgs))
        .setTimeout(60)
        .build();

      const prepared = await srv.prepareTransaction(tx);
      prepared.sign(admin);

      const sendResult = await srv.sendTransaction(prepared);
      if (sendResult.status === 'ERROR') {
        throw new Error(`submit failed for ${method}: ${JSON.stringify(sendResult.errorResult ?? sendResult)}`);
      }

      const finalResult = await srv.pollTransaction(sendResult.hash);
      if (finalResult.status !== 'SUCCESS') {
        throw new Error(`${method} transaction ${sendResult.hash} did not succeed: ${finalResult.status}`);
      }
      return { hash: sendResult.hash, result: finalResult };
    },
    { attempts: 2, timeoutMs: 10_000, baseDelayMs: 300, label: `invokeAsAdmin(${method})` },
  );
}

export async function resolveQuestion(questionId, matchingWorkerAddresses, losingWorkerAddresses = []) {
  return invokeAsAdmin('resolve', [
    u64Arg(questionId),
    vecOfAddresses(matchingWorkerAddresses),
    vecOfAddresses(losingWorkerAddresses),
  ]);
}

export async function refundQuestion(questionId) {
  return invokeAsAdmin('refund', [u64Arg(questionId)]);
}

/** Draws down a payer's prepaid on-chain balance and opens `questionId`,
 * with no signature from the payer on this specific call — see charge() in
 * the contract. Throws (via invokeAsAdmin's retry) if the balance can't
 * cover `amountStroops`; callers must not treat that as safe to retry blind,
 * since retrying an insufficient charge just fails the same way again. */
export async function chargeBalance(payerAddress, questionId, amountStroops) {
  return invokeAsAdmin('charge', [addressArg(payerAddress), u64Arg(questionId), i128Arg(amountStroops)]);
}

export function decodeStatus(raw) {
  // A data-less Rust enum variant (Status::Pending etc.) decodes via
  // scValToNative as a single-element ARRAY, e.g. ['Pending'] — confirmed
  // against a real deployed contract's live RPC response (soroban-sdk 23 /
  // @stellar/stellar-sdk 16), not assumed from memory. This was a genuine
  // bug: the previous version here assumed a plain-object shape that never
  // matched real output, so onChain.status silently decoded to "0" (an
  // array's stringified numeric key) instead of "pending" — invisible to
  // every test in this repo because none of them decode a *real*
  // simulateTransaction response, only mocked ones.
  if (Array.isArray(raw)) return String(raw[0]).toLowerCase();
  if (typeof raw === 'string') return raw.toLowerCase();
  if (raw && typeof raw === 'object') return Object.keys(raw)[0]?.toLowerCase();
  return String(raw).toLowerCase();
}

async function simulateReadOnly(method, scValArgs = []) {
  return withRetry(
    async () => {
      const srv = getServer();
      const contract = new Contract(config.contractId);
      // Simulation-only calls need a source account for a well-formed envelope
      // but never actually sign or submit, so any funded-looking public key works.
      const simSourceKey = config.platformAddress || Keypair.random().publicKey();
      const simSource = new Account(simSourceKey, '0');

      const tx = new TransactionBuilder(simSource, { fee: '100', networkPassphrase: config.networkPassphrase })
        .addOperation(contract.call(method, ...scValArgs))
        .setTimeout(30)
        .build();

      const sim = await srv.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        if (/QuestionNotFound|Error\(Contract, #5\)/.test(sim.error ?? '')) return null;
        throw new Error(`simulation of ${method} failed: ${sim.error}`);
      }
      if (!sim.result?.retval) return null;
      return scValToNative(sim.result.retval);
    },
    { attempts: 2, timeoutMs: 5_000, baseDelayMs: 200, label: `simulateReadOnly(${method})` },
  );
}

/** Zero-fee simulated read — checks payment state without needing a signature. */
export async function getQuestionOnChain(questionId) {
  const native = await simulateReadOnly('get_question', [u64Arg(questionId)]);
  if (!native) return null;
  return {
    payer: native.payer,
    amount: BigInt(native.amount),
    status: decodeStatus(native.status),
    createdAt: Number(native.created_at),
  };
}

export async function getTimeoutLedgersOnChain() {
  return simulateReadOnly('get_timeout_ledgers');
}

export async function getOwedOnChain(workerAddress) {
  const owed = await simulateReadOnly('get_owed', [addressArg(workerAddress)]);
  return BigInt(owed ?? 0);
}

export async function getStakeOnChain(workerAddress) {
  const stake = await simulateReadOnly('get_stake', [addressArg(workerAddress)]);
  return BigInt(stake ?? 0);
}

export async function getBalanceOnChain(payerAddress) {
  const balance = await simulateReadOnly('get_balance', [addressArg(payerAddress)]);
  return BigInt(balance ?? 0);
}
