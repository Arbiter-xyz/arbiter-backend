import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ArbiterClient,
  AuthenticationError,
  ConflictError,
  InsufficientBalanceError,
  JobTimeoutError,
  PaymentRequiredError,
  type Job,
} from '../src/index.ts';
import { BASE_URL, JOB_BASE, mockFetch } from './helpers.ts';

const CHALLENGE = {
  questionId: '42',
  amount: '0.2500000',
  amountStroops: '2500000',
  surgeMultiplier: 1,
  asset: { code: 'USDC', issuer: 'GISSUER', sacId: 'CSAC' },
  contractId: 'CCONTRACT',
  network: 'Test SDF Network ; September 2015',
  tier: 'standard',
  tiers: [],
  quorumSize: 3,
  timeoutMs: 45_000,
  autoRefundAfterLedgers: 100,
  instructions: 'Call submit(...)',
};

const ACCEPTED = { jobId: '42', questionId: '42', statusUrl: '/oracle/42', cancellableUntil: 123, cancelUrl: '/oracle/42/cancel' };

const client = (fetch: ReturnType<typeof mockFetch>['fetch'], extra = {}) =>
  new ArbiterClient({ baseUrl: BASE_URL, fetch, retryBaseDelayMs: 1, ...extra });

describe('classic 402 flow', () => {
  test('requestChallenge returns the 402 challenge as a normal result', async () => {
    const { fetch, requests } = mockFetch([{ status: 402, body: CHALLENGE }]);
    const challenge = await client(fetch).requestChallenge('Is the bridge open?', { tier: 'standard', category: 'traffic' });

    assert.deepEqual(challenge, CHALLENGE);
    assert.equal(requests[0]!.method, 'POST');
    assert.equal(requests[0]!.url.pathname, '/oracle');
    assert.deepEqual(requests[0]!.body, { question: 'Is the bridge open?', tier: 'standard', category: 'traffic' });
    assert.equal(requests[0]!.headers.authorization, undefined);
  });

  test('requestChallenge sends Idempotency-Key and only then retries', async () => {
    const keyed = mockFetch([{ status: 503, body: { error: 'down' } }, { status: 402, body: CHALLENGE }]);
    await client(keyed.fetch).requestChallenge('q', { idempotencyKey: 'idem-1' });
    assert.equal(keyed.requests.length, 2);
    assert.equal(keyed.requests[1]!.headers['idempotency-key'], 'idem-1');

    const unkeyed = mockFetch([{ status: 503, body: { error: 'down' } }]);
    await assert.rejects(client(unkeyed.fetch).requestChallenge('q'));
    assert.equal(unkeyed.requests.length, 1, 'without a key a retry would mint a second questionId');
  });

  test('submitPayment sends the payment headers and returns the accepted job', async () => {
    const { fetch, requests } = mockFetch([{ status: 202, body: ACCEPTED }]);
    const accepted = await client(fetch).submitPayment({ questionId: '42', paymentTx: 'abc123' });

    assert.deepEqual(accepted, ACCEPTED);
    assert.equal(requests[0]!.headers['x-question-id'], '42');
    assert.equal(requests[0]!.headers['x-payment-tx'], 'abc123');
  });

  test('submitPayment keeps re-checking while the payment is not yet visible on-chain', async () => {
    const notYet = { status: 402, body: { questionId: '42', reason: 'payment not yet visible on-chain' } };
    const { fetch, requests } = mockFetch([notYet, notYet, { status: 202, body: ACCEPTED }]);
    const accepted = await client(fetch).submitPayment({ questionId: '42', paymentTx: 'tx' }, { pollIntervalMs: 1 });

    assert.equal(accepted.jobId, '42');
    assert.equal(requests.length, 3);
  });

  test('submitPayment fails fast on a real payment problem', async () => {
    const { fetch, requests } = mockFetch([
      { status: 402, body: { questionId: '42', reason: 'on-chain payment amount is below the quoted price' } },
    ]);
    await assert.rejects(
      client(fetch).submitPayment({ questionId: '42', paymentTx: 'tx' }, { pollIntervalMs: 1 }),
      (err: unknown) => err instanceof PaymentRequiredError && /below the quoted price/.test(err.message),
    );
    assert.equal(requests.length, 1);
  });

  test('submitPayment gives up once waitForPaymentMs elapses', async () => {
    const notYet = { status: 402, body: { reason: 'payment not yet visible on-chain' } };
    const { fetch } = mockFetch(() => notYet);
    await assert.rejects(
      client(fetch).submitPayment({ questionId: '42', paymentTx: 'tx' }, { waitForPaymentMs: 30, pollIntervalMs: 5 }),
      PaymentRequiredError,
    );
  });
});

describe('metered (payerAddress + session token) flow', () => {
  test('askMetered sends payerAddress and token in the body, and no API key', async () => {
    const { fetch, requests } = mockFetch([{ status: 202, body: { ...ACCEPTED, tier: 'express', amount: '0.4', amountStroops: '4000000', tiers: [] } }]);
    const accepted = await client(fetch, { apiKey: 'ak_live_x' }).askMetered('q?', {
      payerAddress: 'GPAYER',
      token: 'sess.tok',
      tier: 'express',
    });

    assert.equal(accepted.tier, 'express');
    assert.deepEqual(requests[0]!.body, { question: 'q?', tier: 'express', payerAddress: 'GPAYER', token: 'sess.tok' });
    assert.equal(requests[0]!.headers.authorization, undefined, 'the API key would switch the backend to the API-key path');
  });

  test('insufficient prepaid balance surfaces the deposit instructions', async () => {
    const { fetch } = mockFetch([
      { status: 402, body: { error: 'insufficient prepaid balance', payerAddress: 'GPAYER', instructions: 'Call deposit(...)' } },
    ]);
    await assert.rejects(client(fetch).askMetered('q', { payerAddress: 'GPAYER', token: 't' }), (err: unknown) => {
      assert.ok(err instanceof InsufficientBalanceError);
      assert.ok(err instanceof PaymentRequiredError);
      assert.equal(err.payerAddress, 'GPAYER');
      assert.equal(err.instructions, 'Call deposit(...)');
      return true;
    });
  });

  test('an invalid session is an AuthenticationError', async () => {
    const { fetch } = mockFetch([{ status: 401, body: { error: 'a valid session token for this address is required' } }]);
    await assert.rejects(client(fetch).askMetered('q', { payerAddress: 'G', token: 'bad' }), AuthenticationError);
  });

  test('is never retried — a lost response after the charge must not charge twice', async () => {
    const { fetch, requests } = mockFetch([{ status: 500, body: { error: 'failed' } }, { status: 202, body: ACCEPTED }]);
    await assert.rejects(client(fetch).askMetered('q', { payerAddress: 'G', token: 't' }));
    assert.equal(requests.length, 1);
  });
});

describe('API-key flow', () => {
  test('askWithApiKey sends the bearer key', async () => {
    const { fetch, requests } = mockFetch([{ status: 202, body: ACCEPTED }]);
    await client(fetch, { apiKey: 'ak_live_abc' }).askWithApiKey('q', { tier: 'priority' });
    assert.equal(requests[0]!.headers.authorization, 'Bearer ak_live_abc');
    assert.deepEqual(requests[0]!.body, { question: 'q', tier: 'priority' });
  });

  test('insufficient credit is a PaymentRequiredError, and a 503 is not retried', async () => {
    const credit = mockFetch([{ status: 402, body: { error: 'insufficient credit balance — top up via POST /billing/checkout' } }]);
    await assert.rejects(client(credit.fetch, { apiKey: 'ak_live_x' }).askWithApiKey('q'), (err: unknown) =>
      err instanceof PaymentRequiredError && !(err instanceof InsufficientBalanceError),
    );

    const busy = mockFetch([{ status: 503, body: { error: 'temporarily unable' } }, { status: 202, body: ACCEPTED }]);
    await assert.rejects(client(busy.fetch, { apiKey: 'ak_live_x' }).askWithApiKey('q'));
    assert.equal(busy.requests.length, 1);
  });

  test('askWithApiKey without an apiKey fails before any request', async () => {
    const { fetch, requests } = mockFetch([]);
    await assert.rejects(client(fetch).askWithApiKey('q'), TypeError);
    assert.equal(requests.length, 0);
  });
});

describe('ask() picks the payment path', () => {
  test('API key wins when configured, else payerAddress + token, else it refuses', async () => {
    const withKey = mockFetch([{ status: 202, body: ACCEPTED }]);
    await client(withKey.fetch, { apiKey: 'ak_live_k' }).ask('q');
    assert.equal(withKey.requests[0]!.headers.authorization, 'Bearer ak_live_k');

    const metered = mockFetch([{ status: 202, body: ACCEPTED }]);
    await client(metered.fetch).ask('q', { payerAddress: 'GP', token: 't' });
    assert.equal(metered.requests[0]!.body.payerAddress, 'GP');

    await assert.rejects(client(mockFetch([]).fetch).ask('q'), TypeError);
  });
});

describe('sandbox, polling, and cancel', () => {
  test('askSandbox posts to /oracle/sandbox with the simulate mode', async () => {
    const { fetch, requests } = mockFetch([{ status: 202, body: { sandbox: true, jobId: '7', statusUrl: '/oracle/7' } }]);
    const res = await client(fetch).askSandbox('q', { simulate: 'disagreement' });
    assert.equal(res.jobId, '7');
    assert.equal(requests[0]!.url.pathname, '/oracle/sandbox');
    assert.deepEqual(requests[0]!.body, { question: 'q', simulate: 'disagreement' });
  });

  test('waitForResult polls through 202s until settled and reports every update', async () => {
    const states: Job[] = [
      { ...JOB_BASE, jobId: '9', status: 'holding', cancellableUntil: 5 } as Job,
      { ...JOB_BASE, jobId: '9', status: 'awaiting_workers' } as Job,
      { ...JOB_BASE, jobId: '9', status: 'settled', outcome: 'resolved', answer: 'Yes' } as Job,
    ];
    const { fetch, requests } = mockFetch(states.map((body, i) => ({ status: i === 2 ? 200 : 202, body })));
    const seen: string[] = [];
    const job = await client(fetch).waitForResult('9', { intervalMs: 1, onUpdate: (j) => seen.push(j.status) });

    assert.equal(job.outcome, 'resolved');
    assert.equal(job.answer, 'Yes');
    assert.deepEqual(seen, ['holding', 'awaiting_workers', 'settled']);
    assert.ok(requests.every((r) => r.method === 'GET' && r.url.pathname === '/oracle/9'));
  });

  test('waitForResult throws JobTimeoutError with the last status', async () => {
    const { fetch } = mockFetch(() => ({ status: 202, body: { ...JOB_BASE, jobId: '9', status: 'reconciling' } }));
    await assert.rejects(client(fetch).waitForResult('9', { intervalMs: 5, timeoutMs: 20 }), (err: unknown) => {
      assert.ok(err instanceof JobTimeoutError);
      assert.equal(err.lastStatus, 'reconciling');
      return true;
    });
  });

  test('waitForResult stops when its signal aborts', async () => {
    const { fetch } = mockFetch(() => ({ status: 202, body: { ...JOB_BASE, jobId: '9', status: 'awaiting_workers' } }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('stop')), 20);
    await assert.rejects(client(fetch).waitForResult('9', { intervalMs: 5, signal: controller.signal }), /stop/);
  });

  test('cancel uses the session token, or the API key when no token is given', async () => {
    const settled = { ...JOB_BASE, jobId: '42', status: 'settled', outcome: 'refunded', cancelledByPayer: true };
    const byToken = mockFetch([{ status: 200, body: settled }]);
    const job = await client(byToken.fetch, { apiKey: 'ak_live_k' }).cancel('42', { token: 'sess' });
    assert.equal(job.cancelledByPayer, true);
    assert.equal(byToken.requests[0]!.url.pathname, '/oracle/42/cancel');
    assert.deepEqual(byToken.requests[0]!.body, { token: 'sess' });
    assert.equal(byToken.requests[0]!.headers.authorization, undefined);

    const byKey = mockFetch([{ status: 200, body: settled }]);
    await client(byKey.fetch, { apiKey: 'ak_live_k' }).cancel('42');
    assert.equal(byKey.requests[0]!.headers.authorization, 'Bearer ak_live_k');
  });

  test('cancelling after the undo window closed is a ConflictError', async () => {
    const { fetch } = mockFetch([{ status: 409, body: { jobId: '42', error: 'already dispatched to workers — the undo window has closed' } }]);
    await assert.rejects(client(fetch).cancel('42', { token: 't' }), ConflictError);
  });
});
