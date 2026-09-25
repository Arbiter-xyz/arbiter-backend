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

/** Comma-separated list of configured RPC URLs, mirroring
 * config.allowedOrigins' comma-split parsing convention. The first entry is
 * the primary; the rest are ordered failover candidates. A single-URL
 * configuration yields a one-element list, so no failover path is ever
 * exercised. */
function getRpcUrls() {
  return String(config.sorobanRpcUrl || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
}

const failoverServers = new Map();
function getServerForUrl(url) {
  if (!failoverServers.has(url)) {
    failoverServers.set(url, new rpc.Server(url, { allowHttp: url.startsWith('http://') }));
  }
  return failoverServers.get(url);
}

/** Runs `fn(srv)` against the primary server, and if it throws (e.g. a
 * withRetry-exhausted failure against a degraded provider), retries once
 * against each subsequent configured URL before giving up. Failover happens
 * only *before* a call starts — `fn` is re-invoked from scratch against the
 * next server, never resumed mid-flight — so a mid-submission failover can
 * never race the sequence number createSerialQueue() serializes over. */
async function withServerFailover(fn) {
  const urls = getRpcUrls();
  let lastErr;
  for (let i = 0; i < urls.length; i++) {
    const srv = i === 0 ? getServer() : getServerForUrl(urls[i]);
    try {
      return await fn(srv);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
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
 *
 * Failover is layered *outside* withRetry: the whole retried flow is
 * re-run against the next configured URL only after the primary's retries
 * are exhausted, so a failover attempt always starts with its own fresh
 * getAccount() read against the server that will actually submit it.
 */
async function runInvokeAsAdmin(method, scValArgs) {
  return withServerFailover((srv) =>
    withRetry(
      async () => {
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
    ),
  );
}

/** There is exactly one Stellar account signing every admin call (the
 * platform key), and Stellar requires a strictly increasing, gap-free
 * sequence number per submitted transaction from that account. Two
 * invokeAsAdmin() calls that overlap in time would otherwise both fetch
 * the *same* current sequence and both build a transaction for
 * `sequence + 1` — only one can land, and the other fails outright rather
 * than retrying into success, since a fresh getAccount() read moments
 * later would just collide with a THIRD concurrent caller instead. This
 * is ordinary production traffic, not a rare edge case: two questions
 * settling around the same moment, or sweepWorkerTtls()'s daily
 * Promise.all() fan-out across every known worker, all sign from this
 * same key at once.
 *
 * Queuing every call onto one chain — waiting for the previous call's
 * entire build/sign/submit/poll cycle to finish before the next one even
 * reads a sequence number — is what actually fixes it: by the time a
 * queued call's runInvokeAsAdmin() does its own getAccount() read, the
 * previous call's sequence bump has already landed on a closed ledger
 * (pollTransaction waits for that), so there is never a stale snapshot
 * for two calls to race over. The queue variable itself always resolves,
 * regardless of whether the call it's tracking succeeded or failed — only
 * `result` (returned to the real caller) carries the real outcome — so
 * one failed admin call can never wedge every later one behind a
 * permanently-rejected link.
 *
 * The queueing itself is Stellar-agnostic, so it's factored out as its own
 * function and exported — directly testable without mocking the RPC layer
 * at all, the same reason computeSmoothedCount/stakeGateAllows/
 * surgeMultiplier exist as pure functions elsewhere in this codebase. */
export function createSerialQueue() {
  let tail = Promise.resolve();
  return function serialize(fn) {
    const result = tail.then(fn, fn);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
}

const serializeAdminCall = createSerialQueue();

function invokeAsAdmin(method, scValArgs) {
  return serializeAdminCall(() => runInvokeAsAdmin(method, scValArgs));
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
  return withServerFailover((srv) =>
    withRetry(
      async () => {
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
          throw new Error(`simulate ${method} failed: ${sim.error}`);
        }
        return sim;
      },
      { attempts: 2, timeoutMs: 10_000, baseDelayMs: 300, label: `simulateReadOnly(${method})` },
    ),
  );
}

export async function getQuestionOnChain(questionId) {
  const sim = await simulateReadOnly('get_question', [u64Arg(questionId)]);
  const raw = sim.result?.retval;
  if (raw === undefined) return null;
  const decoded = scValToNative(raw);
  if (!decoded) return null;
  return {
    id: Number(decoded.id),
    status: decodeStatus(decoded.status),
    matchingWorkers: decoded.matching_workers ?? [],
    losingWorkers: decoded.losing_workers ?? [],
  };
}
