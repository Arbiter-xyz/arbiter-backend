import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { issueChallengeIdempotent } from '../src/oracle.js';
import { claimJob } from '../src/jobs.js';

test('issueChallengeIdempotent with no key mints a fresh questionId every call (current default behavior unchanged)', async () => {
  const a = await issueChallengeIdempotent('question A', 'standard', null, undefined);
  const b = await issueChallengeIdempotent('question A', 'standard', null, undefined);
  assert.notEqual(a.questionId, b.questionId);
});

test('issueChallengeIdempotent with the SAME key returns the exact same challenge on retry, not a new questionId', async () => {
  const key = `idem-${Date.now()}`;
  const first = await issueChallengeIdempotent('what is 2+2', 'standard', null, key);
  const second = await issueChallengeIdempotent('what is 2+2', 'standard', null, key);
  assert.equal(second.questionId, first.questionId);
  assert.deepEqual(second, first);
});

test('issueChallengeIdempotent with DIFFERENT keys mints independent questionIds even for the same question text', async () => {
  const first = await issueChallengeIdempotent('same text', 'standard', null, `key-a-${Date.now()}`);
  const second = await issueChallengeIdempotent('same text', 'standard', null, `key-b-${Date.now()}`);
  assert.notEqual(first.questionId, second.questionId);
});

test('claimJob: only the first caller for a given jobId claims it, every subsequent call for the same id returns false', async () => {
  const jobId = `claim-test-${Date.now()}`;
  assert.equal(await claimJob(jobId), true);
  assert.equal(await claimJob(jobId), false);
  assert.equal(await claimJob(jobId), false);
});

test('claimJob: concurrent (racing) claims for the same id — exactly one wins, matching the fulfillment double-dispatch scenario', async () => {
  const jobId = `claim-race-${Date.now()}`;
  const results = await Promise.all(Array.from({ length: 10 }, () => claimJob(jobId)));
  const winners = results.filter(Boolean);
  assert.equal(winners.length, 1, 'exactly one concurrent claimJob() call must win');
});

test('claimJob: different job ids never contend with each other', async () => {
  const a = `claim-a-${Date.now()}`;
  const b = `claim-b-${Date.now()}`;
  assert.equal(await claimJob(a), true);
  assert.equal(await claimJob(b), true);
});

// --- Network-level stress tests (issue #9) ---------------------------------
//
// The tests above exercise claimJob()/issueChallengeIdempotent() as in-process
// function calls. Real duplicate delivery happens over the network: a proxy or
// client retry opens *separate* TCP connections and fires the exact same
// request truly simultaneously. Node's event loop and the network stack can
// schedule those differently than a Promise.all race, so we stress the real
// HTTP server here.

/**
 * Boot the real HTTP server on an ephemeral port and return a helper that
 * fires a single POST /oracle request over its own dedicated connection.
 *
 * Each request uses `agent: false` so it gets a fresh socket — this is what
 * makes the requests genuinely simultaneous at the network level rather than
 * being serialized through a shared keep-alive connection pool.
 */
async function startServer() {
  const { createServer } = await import('../src/server.js');
  const server = await createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const postOracle = (body, idempotencyKey) =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/oracle',
          agent: false, // dedicated connection per request
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
          },
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            let parsed = null;
            try {
              parsed = data ? JSON.parse(data) : null;
            } catch {
              parsed = data;
            }
            resolve({ status: res.statusCode, body: parsed });
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });

  return { server, postOracle };
}

const CONCURRENCY = 100;
const REPEATS = 25;

/**
 * Fire `count` truly simultaneous POST /oracle requests carrying the same
 * Idempotency-Key and questionId, each on its own connection, and return the
 * parsed responses.
 */
async function fireSimultaneousDuplicates(postOracle, { key, questionId, count }) {
  const body = { question: 'what is 2+2', mode: 'standard', questionId };
  return Promise.all(
    Array.from({ length: count }, () => postOracle(body, key)),
  );
}

test('POST /oracle: 100 simultaneous duplicate requests with the same Idempotency-Key settle on exactly one questionId', async () => {
  const { server, postOracle } = await startServer();
  try {
    const key = `net-idem-${Date.now()}`;
    const responses = await fireSimultaneousDuplicates(postOracle, {
      key,
      questionId: undefined,
      count: CONCURRENCY,
    });

    const ok = responses.filter((r) => r.status >= 200 && r.status < 300);
    assert.equal(
      ok.length,
      CONCURRENCY,
      'every duplicate request must be answered successfully (idempotent replay, not an error)',
    );

    const questionIds = new Set(
      ok.map((r) => r.body && r.body.questionId).filter(Boolean),
    );
    assert.equal(
      questionIds.size,
      1,
      'all simultaneous duplicates must resolve to exactly one questionId',
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /oracle: repeated bursts of simultaneous duplicates never double-dispatch or double-settle', async () => {
  const { server, postOracle } = await startServer();
  try {
    for (let run = 0; run < REPEATS; run += 1) {
      const key = `net-idem-run-${run}-${Date.now()}`;
      const responses = await fireSimultaneousDuplicates(postOracle, {
        key,
        questionId: undefined,
        count: CONCURRENCY,
      });

      const ok = responses.filter((r) => r.status >= 200 && r.status < 300);
      assert.equal(
        ok.length,
        CONCURRENCY,
        `run ${run}: every duplicate must be answered successfully`,
      );

      const questionIds = new Set(
        ok.map((r) => r.body && r.body.questionId).filter(Boolean),
      );
      assert.equal(
        questionIds.size,
        1,
        `run ${run}: exactly one questionId must be created across all duplicates`,
      );

      // Exactly one fulfillment path may execute. The server reports how many
      // times the job was actually dispatched/settled; duplicates must replay
      // the cached result instead of re-dispatching.
      const dispatched = ok.filter(
        (r) => r.body && r.body.dispatched === true,
      ).length;
      assert.equal(
        dispatched,
        1,
        `run ${run}: exactly one request may dispatch the job to workers`,
      );

      const settled = ok.filter(
        (r) => r.body && r.body.settled === true,
      ).length;
      assert.equal(
        settled,
        1,
        `run ${run}: exactly one request may trigger on-chain settlement`,
      );
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /oracle: simultaneous duplicates sharing an explicit questionId claim the job exactly once', async () => {
  const { server, postOracle } = await startServer();
  try {
    const questionId = `net-claim-${Date.now()}`;
    const key = `net-claim-key-${Date.now()}`;
    const responses = await fireSimultaneousDuplicates(postOracle, {
      key,
      questionId,
      count: CONCURRENCY,
    });

    const ok = responses.filter((r) => r.status >= 200 && r.status < 300);
    assert.equal(ok.length, CONCURRENCY);

    const claimed = ok.filter((r) => r.body && r.body.claimed === true).length;
    assert.equal(
      claimed,
      1,
      'exactly one simultaneous request may win the claimJob() race',
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
