import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Account, Keypair, Operation, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import {
  ArbiterClient,
  ArbiterNetworkError,
  AuthenticationError,
  NotFoundError,
  RateLimitedError,
  TESTNET_PASSPHRASE,
} from '../src/index.ts';
import { keypairSigner } from '../src/stellar.ts';
import { BASE_URL, mockFetch } from './helpers.ts';

/**
 * A fake of the backend's session endpoints that builds and verifies the
 * challenge exactly like workerAuth.js does (manage_data "arbiter-auth"
 * carrying a nonce, sequence 0, one signature from the address itself).
 */
function fakeSessionServer() {
  const nonces = new Map<string, string>();
  return mockFetch((req) => {
    const match = req.url.pathname.match(/^\/payers\/([^/]+)\/session(\/challenge)?$/);
    if (!match) return { status: 404, body: { error: 'not found' } };
    const address = decodeURIComponent(match[1]!);

    if (match[2]) {
      const nonce = randomBytes(32).toString('hex');
      nonces.set(address, nonce);
      const tx = new TransactionBuilder(new Account(address, '0'), { fee: '100', networkPassphrase: TESTNET_PASSPHRASE })
        .addOperation(Operation.manageData({ name: 'arbiter-auth', value: nonce }))
        .setTimeout(300)
        .build();
      return { status: 200, body: { xdr: tx.toXDR() } };
    }

    const tx = new Transaction(req.body.signedXdr, TESTNET_PASSPHRASE);
    const op = tx.operations[0] as { value?: Buffer };
    const signedByAddress =
      tx.signatures.length === 1 && Keypair.fromPublicKey(address).verify(tx.hash(), tx.signatures[0]!.signature());
    if (op.value?.toString() !== nonces.get(address) || !signedByAddress) {
      return { status: 401, body: { error: 'challenge verification failed' } };
    }
    nonces.delete(address);
    return { status: 200, body: { token: `token-for-${address}`, expiresAt: 999 } };
  });
}

describe('payer session challenge/response', () => {
  test('authenticatePayer signs the challenge with the payer key and returns a session', async () => {
    const payer = Keypair.random();
    const { fetch, requests } = fakeSessionServer();
    const session = await new ArbiterClient({ baseUrl: BASE_URL, fetch }).authenticatePayer(
      payer.publicKey(),
      keypairSigner(payer.secret()),
    );

    assert.deepEqual(session, { token: `token-for-${payer.publicKey()}`, expiresAt: 999 });
    assert.deepEqual(
      requests.map((r) => `${r.method} ${r.url.pathname}`),
      [`POST /payers/${payer.publicKey()}/session/challenge`, `POST /payers/${payer.publicKey()}/session`],
    );
  });

  test('a signature from a different key is rejected as an AuthenticationError', async () => {
    const payer = Keypair.random();
    const impostor = Keypair.random();
    const { fetch } = fakeSessionServer();
    await assert.rejects(
      new ArbiterClient({ baseUrl: BASE_URL, fetch }).authenticatePayer(payer.publicKey(), keypairSigner(impostor.secret())),
      AuthenticationError,
    );
  });

  test('the signer is given the client network passphrase', async () => {
    const seen: string[] = [];
    const { fetch } = mockFetch([
      { status: 200, body: { xdr: 'XDR' } },
      { status: 200, body: { token: 't', expiresAt: 1 } },
    ]);
    const client = new ArbiterClient({ baseUrl: BASE_URL, fetch, networkPassphrase: 'Custom Net' });
    await client.authenticatePayer('GADDR', (xdr, passphrase) => {
      seen.push(`${xdr}|${passphrase}`);
      return 'SIGNED';
    });
    assert.deepEqual(seen, ['XDR|Custom Net']);
  });
});

describe('read endpoints', () => {
  const reads = [
    ['getPayerBalance', ['GPAY', { token: 'tok' }], '/payers/GPAY/balance', 'token=tok'],
    ['getPayerQuestions', ['GPAY', { token: 'tok' }], '/payers/GPAY/questions', 'token=tok'],
    ['getWorkerOwed', ['GWORK'], '/workers/GWORK/owed', ''],
    ['getWorkerStake', ['GWORK'], '/workers/GWORK/stake', ''],
    ['getWorkerReputation', ['GWORK'], '/workers/GWORK/reputation', ''],
    ['getStats', [], '/stats', ''],
  ] as const;

  for (const [method, args, path, query] of reads) {
    test(`${method} → GET ${path}`, async () => {
      const body = { ok: method };
      const { fetch, requests } = mockFetch([{ status: 200, body }]);
      const client = new ArbiterClient({ baseUrl: BASE_URL, fetch });
      const result = await (client[method] as (...a: unknown[]) => Promise<unknown>)(...args);

      assert.deepEqual(result, body);
      assert.equal(requests[0]!.method, 'GET');
      assert.equal(requests[0]!.url.pathname, path);
      assert.equal(requests[0]!.url.search.replace(/^\?/, ''), query);
    });
  }

  test('getLeaderboard unwraps the list and passes limit', async () => {
    const row = { workerId: 'GW', totalAnswers: 9, matched: 8, matchRatio: 0.89, stakeStroops: '0', stake: '0.0000000', established: true };
    const { fetch, requests } = mockFetch([{ status: 200, body: { leaderboard: [row] } }]);
    const rows = await new ArbiterClient({ baseUrl: BASE_URL, fetch }).getLeaderboard({ limit: 10 });
    assert.deepEqual(rows, [row]);
    assert.equal(requests[0]!.url.search, '?limit=10');
  });

  test('path segments are URL-encoded and a base path prefix is kept', async () => {
    const { fetch, requests } = mockFetch([{ status: 200, body: {} }]);
    await new ArbiterClient({ baseUrl: 'http://arbiter.test/api/v1', fetch }).getJob('a/b?c');
    assert.equal(requests[0]!.url.pathname, '/api/v1/oracle/a%2Fb%3Fc');
  });

  test('an unknown job is a NotFoundError', async () => {
    const { fetch } = mockFetch([{ status: 404, body: { error: 'unknown or expired jobId' } }]);
    await assert.rejects(new ArbiterClient({ baseUrl: BASE_URL, fetch }).getJob('nope'), NotFoundError);
  });
});

describe('retries and timeouts', () => {
  test('GETs retry on 429 (honouring Retry-After) and 5xx, then succeed', async () => {
    const { fetch, requests } = mockFetch([
      { status: 429, body: { error: 'rate limit exceeded' }, headers: { 'Retry-After': '0' } },
      { status: 502, body: { error: 'bad gateway' } },
      { status: 200, body: { onlineWorkers: 1, totalResolved: 0, totalRefunded: 0, totalSettled: 0 } },
    ]);
    const stats = await new ArbiterClient({ baseUrl: BASE_URL, fetch, retryBaseDelayMs: 1 }).getStats();
    assert.equal(stats.onlineWorkers, 1);
    assert.equal(requests.length, 3);
  });

  test('a persistent 429 surfaces as RateLimitedError once retries are spent', async () => {
    const { fetch, requests } = mockFetch(() => ({ status: 429, body: { error: 'rate limit exceeded for oracle' } }));
    await assert.rejects(
      new ArbiterClient({ baseUrl: BASE_URL, fetch, retryBaseDelayMs: 1, maxRetries: 1 }).getStats(),
      RateLimitedError,
    );
    assert.equal(requests.length, 2);
  });

  test('4xx errors other than 408/425/429 are not retried', async () => {
    const { fetch, requests } = mockFetch(() => ({ status: 401, body: { error: 'nope' } }));
    await assert.rejects(new ArbiterClient({ baseUrl: BASE_URL, fetch, retryBaseDelayMs: 1 }).getPayerBalance('G'), AuthenticationError);
    assert.equal(requests.length, 1);
  });

  test('network failures are retried, then reported as ArbiterNetworkError', async () => {
    const { fetch, requests } = mockFetch(() => new TypeError('fetch failed'));
    await assert.rejects(
      new ArbiterClient({ baseUrl: BASE_URL, fetch, retryBaseDelayMs: 1, maxRetries: 2 }).getStats(),
      ArbiterNetworkError,
    );
    assert.equal(requests.length, 3);
  });

  test('a hung request times out as ArbiterNetworkError', async () => {
    const hanging = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    await assert.rejects(
      new ArbiterClient({ baseUrl: BASE_URL, fetch: hanging, timeoutMs: 20, maxRetries: 0 }).getStats(),
      (err: unknown) => err instanceof ArbiterNetworkError && /timed out after 20ms/.test(err.message),
    );
  });

  test('the constructor requires a baseUrl', () => {
    assert.throws(() => new ArbiterClient({ baseUrl: '' }), TypeError);
  });
});
