import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { withTimeout, withRetry } from '../src/retry.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('withTimeout resolves normally when the function finishes in time', async () => {
  const result = await withTimeout(async () => 'ok', 1000, 'test');
  assert.equal(result, 'ok');
});

test('withTimeout rejects if the function takes longer than the timeout', async () => {
  const slow = () => sleep(500).then(() => 'too late');
  await assert.rejects(() => withTimeout(slow, 50, 'slow-op'), /slow-op timed out after 50ms/);
});

test('withRetry returns immediately on first success, no delay incurred', async () => {
  let calls = 0;
  const start = Date.now();
  const result = await withRetry(async () => {
    calls += 1;
    return 'success';
  });
  assert.equal(result, 'success');
  assert.equal(calls, 1);
  assert.ok(Date.now() - start < 50, 'should not have waited at all');
});

test('withRetry retries a network-shaped error (no status) up to `attempts` times, then throws', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw new Error('ECONNRESET');
        },
        { attempts: 3, baseDelayMs: 1 },
      ),
    /ECONNRESET/,
  );
  assert.equal(calls, 3);
});

test('withRetry succeeds on a later attempt after earlier ones fail (the common real-world case)', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
      return 'eventually ok';
    },
    { attempts: 5, baseDelayMs: 1 },
  );
  assert.equal(result, 'eventually ok');
  assert.equal(calls, 3);
});

test('withRetry does NOT retry a 4xx client error by default — fails fast on the first attempt', async () => {
  let calls = 0;
  const err = Object.assign(new Error('bad request'), { status: 400 });
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw err;
        },
        { attempts: 5, baseDelayMs: 1 },
      ),
    /bad request/,
  );
  assert.equal(calls, 1, '4xx errors should not be retried');
});

test('withRetry DOES retry a 503/429-shaped error', async () => {
  let calls = 0;
  const err = Object.assign(new Error('service unavailable'), { status: 503 });
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw err;
        },
        { attempts: 2, baseDelayMs: 1 },
      ),
  );
  assert.equal(calls, 2);
});

test('withRetry applies exponential backoff between attempts', async () => {
  const delays = [];
  let last = Date.now();
  let calls = 0;
  await assert.rejects(() =>
    withRetry(
      async () => {
        const now = Date.now();
        if (calls > 0) delays.push(now - last);
        last = now;
        calls += 1;
        throw new Error('always fails');
      },
      { attempts: 3, baseDelayMs: 20 },
    ),
  );
  assert.equal(delays.length, 2);
  // second delay should be roughly double the first (40ms vs 20ms) —
  // allow generous slack for scheduler jitter in CI environments.
  assert.ok(delays[1] > delays[0], `expected increasing delays, got ${JSON.stringify(delays)}`);
});

test('withRetry respects a custom isRetryable predicate', async () => {
  let calls = 0;
  await assert.rejects(() =>
    withRetry(
      async () => {
        calls += 1;
        throw new Error('never retry this');
      },
      { attempts: 5, baseDelayMs: 1, isRetryable: () => false },
    ),
  );
  assert.equal(calls, 1);
});

test('withRetry combined with a per-attempt timeout retries a hanging call', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls === 1) return sleep(500).then(() => 'too slow'); // will time out
      return 'fast enough';
    },
    { attempts: 2, baseDelayMs: 1, timeoutMs: 30, label: 'hangy-op' },
  );
  assert.equal(result, 'fast enough');
  assert.equal(calls, 2);
});

// ---------------------------------------------------------------------------
// Chaos / fault-injection harness.
//
// A real in-process HTTP proxy sits between the caller and a "backend"
// endpoint. Each injected failure mode is a distinct, realistic RPC/Horizon
// failure shape. The caller wraps its request in withRetry (with a per-attempt
// timeout) and we assert the fail-closed guarantee: the call either succeeds
// or throws a bounded error — it never hangs forever, so a job can always be
// settled (resolved or refunded) rather than left permanently stuck.
// ---------------------------------------------------------------------------

function startFaultProxy(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function request(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
        } else {
          resolve(body);
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => req.destroy(new Error('socket hang up')));
    }
  });
}

// Each scenario returns a handler for the fault proxy plus the expected outcome.
const FAULT_MODES = [
  {
    name: 'high latency (slow response)',
    handler: (req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }, 500);
    },
  },
  {
    name: 'connection reset mid-response',
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"partial":');
      setTimeout(() => res.socket.destroy(), 10);
    },
  },
  {
    name: 'malformed / truncated XDR payload',
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"xdr":"AAAAA'); // truncated JSON
    },
  },
  {
    name: 'HTTP 5xx burst',
    handler: (req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('service unavailable');
    },
  },
  {
    name: 'partial simulate-but-fail-submit',
    handler: (req, res) => {
      // simulate succeeds, submit fails with a retryable 500
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'submit failed after successful simulate' }));
    },
  },
];

for (const mode of FAULT_MODES) {
  test(`chaos: ${mode.name} settles fail-closed (bounded, never stuck)`, async () => {
    const proxy = await startFaultProxy(mode.handler);
    try {
      let attempts = 0;
      const start = Date.now();
      let settled = false;
      let outcome = null;
      try {
        outcome = await withRetry(
          async () => {
            attempts += 1;
            const body = await request(proxy.url, 100);
            // A malformed/truncated payload must be treated as a failure so the
            // caller can settle the job rather than trusting corrupt data.
            JSON.parse(body);
            return body;
          },
          { attempts: 3, baseDelayMs: 5, timeoutMs: 150, label: mode.name },
        );
        settled = true;
      } catch (err) {
        settled = true;
        outcome = err;
      }
      const elapsed = Date.now() - start;
      assert.ok(settled, 'call must settle (resolve or reject), never hang');
      assert.ok(attempts >= 1, 'at least one attempt must have been made');
      // Bounded: 3 attempts * (150ms timeout + 5ms backoff) with slack.
      assert.ok(elapsed < 2000, `must settle within a bounded time, took ${elapsed}ms`);
      if (outcome instanceof Error) {
        assert.ok(outcome.message, 'rejection must carry a message for settlement logging');
      }
    } finally {
      await proxy.close();
    }
  });
}

test('chaos: transient fault recovers and settles successfully (resolved path)', async () => {
  let hits = 0;
  const proxy = await startFaultProxy((req, res) => {
    hits += 1;
    if (hits < 3) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('flaky');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const result = await withRetry(
      async () => JSON.parse(await request(proxy.url, 100)),
      { attempts: 5, baseDelayMs: 5, timeoutMs: 150, label: 'flaky-rpc' },
    );
    assert.deepEqual(result, { ok: true });
    assert.equal(hits, 3);
  } finally {
    await proxy.close();
  }
});
