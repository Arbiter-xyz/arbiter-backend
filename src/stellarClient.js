import { Keypair, TransactionBuilder, Contract, Account, Address, nativeToScVal, scValToNative, rpc } from '@stellar/stellar-sdk';
import { config } from './config.js';
import { withRetry } from './retry.js';
import { recordAdminInvocation } from './metrics.js';

/** Chaos fault injection: env-gated, inert unless CHAOS_FAULT is set to a
 * recognized scenario. Follows config.js's "everything is an env var with a
 * safe default" convention — the default (unset) leaves every code path
 * byte-for-byte identical to before this existed. Never reachable in
 * production: config.chaosFault is only honored when config.chaosEnabled is
 * true, which itself requires an explicit env opt-in. */
function chaosFault() {
  if (!config.chaosEnabled) return null;
  return config.chaosFault || null;
}

/** Wraps a Soroban RPC call so a chaos scenario can inject a transient
 * failure at exactly the seam retry.js already wraps. When no fault is
 * configured this is a pass-through with zero behavioral change. */
async function withChaosFault(operation, fn) {
  const fault = chaosFault();
  if (fault === `rpc-timeout:${operation}` || fault === `rpc-timeout:${operation}:once`) {
    const err = new Error(`chaos: injected RPC timeout during ${operation}`);
    err.code = 'CHAOS_INJECTED_TIMEOUT';
    throw err;
  }
  return fn();
}

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

/** Live-reloadable contract id. `config.contractId` is frozen at module load,
 * so a redeployment would otherwise require a full process restart. Every
 * call site reads through this accessor instead of the frozen value, and
 * rotateContractId() swaps it in place. */
let currentContractId = config.contractId;

export function getContractId() {
  return currentContractId;
}

/** Rotates the active contract id without a restart. The serial admin-call
 * queue guarantees any in-flight call already queued against the old id
 * finishes (or fails) before a newly-queued call reads the rotated id — see
 * createSerialQueue() below. */
export function rotateContractId(newContractId) {
  if (!newContractId || typeof newContractId !== 'string') {
    throw new Error('rotateContractId requires a non-empty contract id string');
  }
  currentContractId = newContractId;
  return currentContractId;
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
 * starts — makes the sequence numbers strictly ordered by construction.
 * The queue is a plain promise chain: each task's rejection is swallowed
 * for the *chain* (so one failed call can't poison every subsequent
 * call) while still being propagated to that task's own caller.
 */
function createSerialQueue() {
  let tail = Promise.resolve();
  return function enqueue(task) {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

const enqueueAdminCall = createSerialQueue();

/** Public entry point for every admin-signed contract call. Serializes
 * through enqueueAdminCall so concurrent callers never collide on the
 * platform account's sequence number, and records a metric per invocation
 * for observability. */
export async function invokeAsAdmin(method, scValArgs = []) {
  return enqueueAdminCall(async () => {
    const startedAt = Date.now();
    try {
      const result = await runInvokeAsAdmin(method, scValArgs);
      recordAdminInvocation(method, 'success', Date.now() - startedAt);
      return result;
    } catch (err) {
      recordAdminInvocation(method, 'failure', Date.now() - startedAt);
      throw err;
    }
  });
}

/** Reads a contract method via simulation (no submission, no signing). */
export async function simulateRead(method, scValArgs = []) {
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
        const sim = await srv.simulateTransaction(tx);
        if (sim.error) {
          throw new Error(`simulate ${method} failed: ${JSON.stringify(sim.error)}`);
        }
        return sim.result ? scValToNative(sim.result.retval) : null;
      },
      { attempts: 2, timeoutMs: 10_000, baseDelayMs: 300, label: `simulateRead(${method})` },
    ),
  );
}

/** Settles a single question on-chain as the platform admin. */
export async function resolveQuestion(questionId, matchingPool, losingPool) {
  return invokeAsAdmin('resolve', [u64Arg(questionId), i128Arg(matchingPool), i128Arg(losingPool)]);
}

/** Refunds a single question on-chain as the platform admin. */
export async function refundQuestion(questionId) {
  return invokeAsAdmin('refund', [u64Arg(questionId)]);
}

/** NOTE: resolveQuestionsBatch()/refundQuestionsBatch() were removed here.
 * They invoked contract methods `resolve_batch`/`refund_batch` that do not
 * exist in arbiter-contract's src/lib.rs (tracked by arbiter-contract#20,
 * "Add a batch_resolve() entry point", still open). They had zero callers
 * and would have failed with a Soroban host error at submission time the
 * first time anyone wired them up. Whoever implements arbiter-contract#20
 * should reintroduce a batch helper here matching the real on-chain
 * signature (per-question id/matching/losing triples, per-entry outcomes). */
