import test from 'node:test';
import assert from 'node:assert/strict';
import { scValToNative } from '@stellar/stellar-sdk';
import {
  decodeStatus,
  createSerialQueue,
  computeAnswerHash,
  bytes32Arg,
  CONTRACT_ERROR_CODES,
  isContractError,
  isInsufficientBalanceError,
  withServerFailover,
  runInvokeAsAdmin,
} from '../src/stellarClient.js';

// Regression coverage for a real bug found running against a live deployed
// contract on Stellar testnet (round 6): scValToNative decodes a data-less
// Rust enum variant like Status::Pending as a single-element ARRAY
// (['Pending']), not the plain-object shape this function used to assume.
// The old code silently decoded that to "0" (an array's stringified index)
// instead of "pending" — verifyPayment then rejected every real payment
// with "question is 0 on-chain, expected pending". No prior test caught
// this because every other test in this repo only ever exercises mocked
// data, never a real simulateTransaction response.

test('decodeStatus handles the real array shape scValToNative actually produces', () => {
  assert.equal(decodeStatus(['Pending']), 'pending');
  assert.equal(decodeStatus(['Resolved']), 'resolved');
  assert.equal(decodeStatus(['Refunded']), 'refunded');
});

test('decodeStatus still handles a plain string, in case a future SDK version changes shape again', () => {
  assert.equal(decodeStatus('Pending'), 'pending');
});

test('decodeStatus still handles an object-keyed shape as a defensive fallback', () => {
  assert.equal(decodeStatus({ pending: true }), 'pending');
});

test('decodeStatus never throws on an unexpected shape', () => {
  assert.equal(decodeStatus(null), 'null');
  assert.equal(decodeStatus(undefined), 'undefined');
  assert.equal(decodeStatus(0), '0');
});

// Regression coverage for the sequence-number race invokeAsAdmin() used to
// have: every admin-signed contract call re-fetches the account's current
// sequence number, and Stellar requires a strictly increasing, gap-free
// sequence per submitted transaction — two overlapping calls that both
// fetched the same sequence would collide, and in production this
// surfaced as a genuinely-reached consensus getting spuriously refunded
// (oracle.js's settleResolved() falls back to settleRefunded() when the
// admin call exhausts its retries). createSerialQueue() is the fix's
// actual mechanism, factored out standalone so this is testable without
// mocking the RPC layer at all.
test('createSerialQueue runs queued calls one at a time, never overlapping', async () => {
  const serialize = createSerialQueue();
  let concurrentlyRunning = 0;
  let maxConcurrentlyRunning = 0;
  const order = [];

  async function slowCall(id) {
    concurrentlyRunning += 1;
    maxConcurrentlyRunning = Math.max(maxConcurrentlyRunning, concurrentlyRunning);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(id);
    concurrentlyRunning -= 1;
    return id;
  }

  // Fire all three "concurrently" (no await between them) — this is
  // exactly sweepWorkerTtls()'s Promise.all() fan-out shape.
  const results = await Promise.all([1, 2, 3].map((id) => serialize(() => slowCall(id))));

  assert.equal(maxConcurrentlyRunning, 1, 'no two calls should ever be in-flight at the same time');
  assert.deepEqual(order, [1, 2, 3], 'calls should run in the order they were queued');
  assert.deepEqual(results, [1, 2, 3]);
});

test('createSerialQueue does not let one failed call wedge every later call behind it', async () => {
  const serialize = createSerialQueue();

  await assert.rejects(() => serialize(async () => { throw new Error('boom'); }));

  // A later call must still run — a single admin-call failure (e.g. a
  // dropped RPC connection) can never permanently stall the queue for
  // every settlement after it.
  const result = await serialize(async () => 'still works');
  assert.equal(result, 'still works');
});

test('createSerialQueue preserves each call\'s own success/failure outcome to its caller', async () => {
  const serialize = createSerialQueue();

  const [a, bErr, c] = await Promise.allSettled([
    serialize(async () => 'a'),
    serialize(async () => { throw new Error('b failed'); }),
    serialize(async () => 'c'),
  ]);

  assert.equal(a.status, 'fulfilled');
  assert.equal(a.value, 'a');
  assert.equal(bErr.status, 'rejected');
  assert.match(bErr.reason.message, /b failed/);
  assert.equal(c.status, 'fulfilled');
  assert.equal(c.value, 'c');
});

test('computeAnswerHash produces a deterministic 32-byte SHA-256 digest and bytes32Arg encodes it as ScVal Bytes (#232)', () => {
  const h1 = computeAnswerHash('What is 2+2?', '4');
  const h2 = computeAnswerHash('What is 2+2?', '4');
  const h3 = computeAnswerHash('What is 2+2?', '5');

  assert.equal(Buffer.isBuffer(h1), true);
  assert.equal(h1.length, 32);
  assert.deepEqual(h1, h2);
  assert.notDeepEqual(h1, h3);

  const scValFromBuf = bytes32Arg(h1);
  const scValFromHex = bytes32Arg(h1.toString('hex'));
  assert.deepEqual(Buffer.from(scValToNative(scValFromBuf)), h1);
  assert.deepEqual(Buffer.from(scValToNative(scValFromHex)), h1);

  assert.throws(() => bytes32Arg(Buffer.alloc(16)), /32 bytes/);
});

test('CONTRACT_ERROR_CODES and isInsufficientBalanceError match Soroban ContractError #13 (#236)', () => {
  assert.equal(CONTRACT_ERROR_CODES.INSUFFICIENT_BALANCE, 13);
  assert.equal(isInsufficientBalanceError(new Error('HostError: Error(Contract, #13)')), true);
  assert.equal(isInsufficientBalanceError(new Error('HostError: Error(Contract, #130)')), false);
  assert.equal(isContractError('Error(Contract, #13)', 13), true);
  assert.equal(isContractError('Error(Contract, #14)', 13), false);
});

// Regression coverage for #506: withServerFailover() used to derive its URL
// list by re-splitting config.sorobanRpcUrl, which is already only
// sorobanRpcUrls[0] — so the list always had exactly one entry and the
// backup endpoints were never tried. It must now read config.sorobanRpcUrls.
test('withServerFailover retries on the next configured RPC URL when the first fails (#506)', async () => {
  const calls = [];
  const stubServers = {
    'https://rpc-a.example': {
      getAccount: async () => { calls.push('a'); throw new Error('rpc a is down'); },
    },
    'https://rpc-b.example': {
      getAccount: async () => { calls.push('b'); return { id: 'ok-from-b' }; },
    },
  };

  const result = await withServerFailover(
    (srv) => srv.getAccount('GABC'),
    {
      urls: ['https://rpc-a.example', 'https://rpc-b.example'],
      getServerForUrl: (url) => stubServers[url],
    },
  );

  assert.deepEqual(calls, ['a', 'b'], 'the failing primary must be followed by the backup');
  assert.deepEqual(result, { id: 'ok-from-b' });
});

test('withServerFailover throws the last error when every configured RPC URL fails (#506)', async () => {
  const stubServers = {
    'https://rpc-a.example': { getAccount: async () => { throw new Error('a down'); } },
    'https://rpc-b.example': { getAccount: async () => { throw new Error('b down'); } },
  };

  await assert.rejects(
    () => withServerFailover(
      (srv) => srv.getAccount('GABC'),
      {
        urls: ['https://rpc-a.example', 'https://rpc-b.example'],
        getServerForUrl: (url) => stubServers[url],
      },
    ),
    /b down/,
  );
});

// Regression coverage for #507: runInvokeAsAdmin() used to wrap prepare,
// send AND poll in one retried, time-limited closure. A slow-to-confirm tx
// could time out after sendTransaction had already been accepted, and the
// retry would rebuild and resubmit a second resolve()/refund() — which the
// contract rejects, turning a successful settlement into a reported failure.
// Once a hash exists the tx must never be resubmitted; a poll timeout must
// surface as an "unknown" status for the caller to reconcile on-chain.
test('runInvokeAsAdmin never resubmits once a hash exists; a slow poll reports unknown (#507)', async () => {
  let sendCalls = 0;
  let pollCalls = 0;

  const stubServer = {
    getAccount: async () => ({
      accountId: () => 'GADMIN',
      sequenceNumber: () => '1',
      incrementSequenceNumber: () => {},
    }),
    prepareTransaction: async (tx) => tx,
    sendTransaction: async () => {
      sendCalls += 1;
      return { status: 'PENDING', hash: 'deadbeef' };
    },
    pollTransaction: async () => {
      pollCalls += 1;
      // Simulate a confirmation that takes far longer than the poll timeout.
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { status: 'SUCCESS', hash: 'deadbeef' };
    },
  };

  const result = await runInvokeAsAdmin('resolve', [], {
    getServer: () => stubServer,
    pollTimeoutMs: 20,
    retryOptions: { retries: 3, baseDelayMs: 1, timeoutMs: 5000 },
  });

  assert.equal(sendCalls, 1, 'sendTransaction must be called exactly once — never resubmitted');
  assert.equal(pollCalls, 1, 'pollTransaction should be attempted once for the known hash');
  assert.equal(result.status, 'unknown');
  assert.equal(result.hash, 'deadbeef');
});

