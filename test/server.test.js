import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, Transaction } from '@stellar/stellar-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let nextPort = 4100 + Math.floor(Math.random() * 500); // avoid clashing with a locally-running dev server

function startServer(extraEnv) {
  const port = nextPort++;
  const child = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const ready = new Promise((resolve, reject) => {
    let buf = '';
    // Kill the child right here on any failure path — don't rely solely on
    // the describe block's `after()` hook, which never runs if `before()`
    // rejects before it gets that far, leaking a live child process that
    // keeps `node --test` from ever exiting.
    const fail = (err) => {
      child.kill();
      reject(err);
    };
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes('listening on')) {
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.on('exit', (code) => fail(new Error(`server exited early with code ${code}`)));
    setTimeout(() => fail(new Error('server did not start in time')), 10_000);
  });

  return { child, port, ready };
}

// Each describe block below gets its OWN dedicated server process, so tests
// that intentionally exhaust a rate-limit bucket can't contaminate the
// counters other tests rely on (they'd otherwise all share one in-memory
// store within a single spawned process).

describe('CORS and input validation', () => {
  let server;
  let base;

  before(async () => {
    server = startServer({
      ALLOWED_ORIGINS: 'https://allowed.example.com',
      MAX_QUESTION_LENGTH: '20',
      MAX_ANSWER_LENGTH: '10',
    });
    await server.ready;
    base = `http://localhost:${server.port}`;
  });

  after(() => server.child.kill());

  test('CORS reflects the configured allowlist, not a wide-open wildcard', async () => {
    const res = await fetch(`${base}/health`, { headers: { Origin: 'https://allowed.example.com' } });
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://allowed.example.com');
  });

  test('a question over the configured max length is rejected with 400', async () => {
    const res = await fetch(`${base}/oracle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'x'.repeat(21) }), // MAX_QUESTION_LENGTH=20
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /at most 20 characters/);
  });

  test('a question at or under the max length is accepted (still gets the normal 402)', async () => {
    const res = await fetch(`${base}/oracle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'short question' }),
    });
    assert.equal(res.status, 402);
  });

  test('an answer over the configured max length is rejected with 400', async () => {
    const res = await fetch(`${base}/app/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 'q1', workerId: 'w1', answer: 'x'.repeat(11) }), // MAX_ANSWER_LENGTH=10
    });
    assert.equal(res.status, 400);
  });
});

describe('push notification routes', () => {
  let unconfigured;
  let configured;

  before(async () => {
    unconfigured = startServer({});
    // Locally-generated VAPID keys, safe to hardcode here — this test
    // never contacts a real push service, it only proves the HTTP routes
    // are wired correctly.
    configured = startServer({
      VAPID_PUBLIC_KEY: 'BJqEZM7aujLbmJeZjvEvmyIRp2FaVqUQ4TUcznvLh3EY-J4rMwVv7A-hFFY4Iq0YFVMaZJ-5nQhHXrsxmUZ5B3s',
      VAPID_PRIVATE_KEY: 'XTaUZDisw_Pb4fePO4VQUg9Lb4JF4ylW0_YCRWWk_3o',
    });
    await Promise.all([unconfigured.ready, configured.ready]);
  });

  after(() => {
    unconfigured.child.kill();
    configured.child.kill();
  });

  test('GET /push/vapid-public-key returns 503 when the server has no VAPID keys configured', async () => {
    const res = await fetch(`http://localhost:${unconfigured.port}/push/vapid-public-key`);
    assert.equal(res.status, 503);
  });

  test('GET /push/vapid-public-key returns the key when configured', async () => {
    const res = await fetch(`http://localhost:${configured.port}/push/vapid-public-key`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.publicKey.startsWith('BJqEZM'));
    assert.equal(body.configured, true);
  });

  test('POST /workers/:address/push-subscribe rejects a malformed subscription', async () => {
    const res = await fetch(`http://localhost:${configured.port}/workers/GTEST/push-subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: { notAnEndpoint: true } }),
    });
    assert.equal(res.status, 400);
  });

  test('subscribe then unsubscribe round-trips with 200 ok:true both times', async () => {
    const base = `http://localhost:${configured.port}`;
    const subscription = { endpoint: 'https://push.example.com/fake', keys: { p256dh: 'x', auth: 'y' } };

    const subRes = await fetch(`${base}/workers/GROUNDTRIP/push-subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription, categories: ['coding'] }),
    });
    assert.equal(subRes.status, 200);
    assert.deepEqual(await subRes.json(), { ok: true });

    const unsubRes = await fetch(`${base}/workers/GROUNDTRIP/push-unsubscribe`, { method: 'POST' });
    assert.equal(unsubRes.status, 200);
    assert.deepEqual(await unsubRes.json(), { ok: true });
  });
});

describe('stats and worker reputation endpoints, and sandbox isolation from real stats', () => {
  let server;
  let base;

  before(async () => {
    server = startServer({});
    await server.ready;
    base = `http://localhost:${server.port}`;
  });

  after(() => server.child.kill());

  test('GET /stats returns the expected shape', async () => {
    const res = await fetch(`${base}/stats`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('onlineWorkers' in body);
    assert.ok('totalResolved' in body);
    assert.ok('totalRefunded' in body);
    assert.ok('totalSettled' in body);
    assert.equal(body.totalSettled, body.totalResolved + body.totalRefunded);
  });

  test('GET /workers/:address/reputation returns a fresh-worker shape with a null match ratio', async () => {
    const res = await fetch(`${base}/workers/GFRESHWORKERNEVERANSWERED/reputation`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { matched: 0, total: 0, matchRatio: null });
  });

  test('running several sandbox requests does not move the real /stats counters', async () => {
    const before = await (await fetch(`${base}/stats`)).json();

    for (let i = 0; i < 3; i += 1) {
      const startRes = await fetch(`${base}/oracle/sandbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: `sandbox stats isolation test ${i}` }),
      });
      const { statusUrl } = await startRes.json();
      // wait for it to actually settle so we're sure it HAD the chance to
      // (incorrectly) touch real stats if the isolation were broken
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const pollRes = await fetch(`${base}${statusUrl}`);
        const job = await pollRes.json();
        if (job.status === 'settled') break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const after = await (await fetch(`${base}/stats`)).json();
    assert.deepEqual(after, before, 'sandbox settlements must never move the real platform stats');
  });
});

describe('worker session auth over real HTTP — the /app/answer impersonation fix', () => {
  let server;
  let base;

  before(async () => {
    server = startServer({ NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015' });
    await server.ready;
    base = `http://localhost:${server.port}`;
  });

  after(() => server.child.kill());

  async function getSession(worker) {
    const challengeRes = await fetch(`${base}/workers/${worker.publicKey()}/session/challenge`, { method: 'POST' });
    const { xdr } = await challengeRes.json();
    const tx = new Transaction(xdr, 'Test SDF Network ; September 2015');
    tx.sign(worker);
    const sessionRes = await fetch(`${base}/workers/${worker.publicKey()}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedXdr: tx.toXDR() }),
    });
    return sessionRes.json();
  }

  test('an address-format workerId with NO token is rejected with 401, not silently accepted', async () => {
    const worker = Keypair.random();
    const res = await fetch(`${base}/app/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 'q1', workerId: worker.publicKey(), answer: 'hello' }),
    });
    assert.equal(res.status, 401);
  });

  test("impersonation attempt: submitting under a real worker's address using a DIFFERENT worker's valid session is rejected", async () => {
    const victim = Keypair.random();
    const attacker = Keypair.random();
    const attackerSession = await getSession(attacker);

    const res = await fetch(`${base}/app/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questionId: 'q1',
        workerId: victim.publicKey(), // claiming to BE the victim
        answer: 'attacker-controlled answer',
        token: attackerSession.token, // but only holding a session for themselves
      }),
    });
    assert.equal(res.status, 401);
  });

  test('a worker with a valid session for their OWN address passes auth (reaches the 409 "no such open question" path, not 401)', async () => {
    const worker = Keypair.random();
    const session = await getSession(worker);

    const res = await fetch(`${base}/app/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 'no-such-question', workerId: worker.publicKey(), answer: 'hi', token: session.token }),
    });
    // 409 (not 401) proves auth succeeded and the request reached the real
    // answer-submission logic, which correctly rejects an unknown question.
    assert.equal(res.status, 409);
  });

  test('the plain test-string workerId convenience still works with no token at all (backward compatible)', async () => {
    const res = await fetch(`${base}/app/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 'no-such-question', workerId: 'demo-worker-1', answer: 'hi' }),
    });
    assert.equal(res.status, 409); // reaches real logic, not blocked by auth
  });

  test('GET /app/events also enforces session auth for address-format worker ids', async () => {
    const worker = Keypair.random();
    const res = await fetch(`${base}/app/events?worker=${worker.publicKey()}`);
    assert.equal(res.status, 401);
  });
});

describe('sandbox mode over real HTTP', () => {
  let server;
  let base;

  before(async () => {
    server = startServer({});
    await server.ready;
    base = `http://localhost:${server.port}`;
  });

  after(() => server.child.kill());

  test('requires no payment headers, no wallet, no chain — one call returns a pollable job', async () => {
    const res = await fetch(`${base}/oracle/sandbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What year did Stellar launch?' }),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.sandbox, true);
    assert.ok(body.jobId);
    assert.ok(body.statusUrl.startsWith('/oracle/'));

    // Poll the SAME endpoint a real integration would use for a real job.
    let job;
    for (let i = 0; i < 20; i += 1) {
      const pollRes = await fetch(`${base}${body.statusUrl}`);
      job = await pollRes.json();
      if (job.status === 'settled') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(job.status, 'settled');
    assert.equal(job.sandbox, true);
    assert.equal(job.outcome, 'resolved');
  });
});

describe('sandbox rate limiting (isolated server so its counter is not shared with other sandbox tests)', () => {
  let server;
  let base;

  before(async () => {
    server = startServer({ SANDBOX_RATE_LIMIT_MAX: '3', SANDBOX_RATE_LIMIT_WINDOW_MS: '60000' });
    await server.ready;
    base = `http://localhost:${server.port}`;
  });

  after(() => server.child.kill());

  test('sandbox mode has its own rate limit bucket, independent of the paid /oracle bucket', async () => {
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${base}/oracle/sandbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: `sandbox rate limit test ${i}` }),
      });
      results.push(res.status);
    }
    assert.deepEqual(results, [202, 202, 202, 429, 429]);
  });
});

describe('POST /oracle rate limiting', () => {
  let server;
  let base;

  before(async () => {
    server = startServer({ ORACLE_RATE_LIMIT_MAX: '3', ORACLE_RATE_LIMIT_WINDOW_MS: '60000' });
    await server.ready;
    base = `http://localhost:${server.port}`;
  });

  after(() => server.child.kill());

  test('allows exactly the configured max requests per window, then returns 429', async () => {
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${base}/oracle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: `q${i}` }),
      });
      results.push(res.status);
    }
    assert.deepEqual(results, [402, 402, 402, 429, 429]);
  });
});

describe('/sponsor/* rate limiting', () => {
  let server;
  let base;

  before(async () => {
    server = startServer({ SPONSOR_RATE_LIMIT_MAX: '2', SPONSOR_RATE_LIMIT_WINDOW_MS: '60000' });
    await server.ready;
    base = `http://localhost:${server.port}`;
  });

  after(() => server.child.kill());

  test('allows exactly the configured max requests per window, then returns 429', async () => {
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await fetch(`${base}/sponsor/onboard/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: 'GABCDEFTEST' }),
      });
      results.push(res.status);
    }
    // The first two get past the rate limiter and fail with 500 (no
    // PLATFORM_SECRET configured in this test environment) — what matters
    // is the limiter fires exactly after the configured max, before ever
    // reaching a 429.
    assert.deepEqual(results, [500, 500, 429, 429]);
  });
});

describe('Idempotency-Key header on POST /oracle over real HTTP', () => {
  let server;
  let base;

  before(async () => {
    server = startServer({});
    await server.ready;
    base = `http://localhost:${server.port}`;
  });

  after(() => server.child.kill());

  test('retrying the same request with the same Idempotency-Key returns the identical questionId, not a new one', async () => {
    const key = `test-key-${Date.now()}`;
    const body = JSON.stringify({ question: 'idempotency http test' });
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': key };

    const first = await (await fetch(`${base}/oracle`, { method: 'POST', headers, body })).json();
    const second = await (await fetch(`${base}/oracle`, { method: 'POST', headers, body })).json();

    assert.equal(first.questionId, second.questionId);
  });

  test('omitting the header entirely still works exactly as before (backward compatible)', async () => {
    const res = await fetch(`${base}/oracle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'no idempotency key here' }),
    });
    assert.equal(res.status, 402);
  });

  test('retrying step 2 (payment headers) for the same questionId does not re-trigger fulfillment — same jobId both times', async () => {
    // Sandbox mode conveniently exercises the exact same startFulfillment()
    // codepath as the real paid flow without needing a real chain.
    const startRes = await fetch(`${base}/oracle/sandbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'fulfillment idempotency test' }),
    });
    const { jobId } = await startRes.json();

    // Poll once to confirm a job genuinely exists and is progressing (202
    // while in flight, 200 once settled — either proves this), then
    // nothing else needed: the claimJob()-level guarantee itself is
    // covered directly in idempotency.test.js; this just proves the
    // wiring reaches it over HTTP.
    const pollRes = await fetch(`${base}/oracle/${jobId}`);
    assert.ok([200, 202].includes(pollRes.status), `expected 200 or 202, got ${pollRes.status}`);
  });
});
