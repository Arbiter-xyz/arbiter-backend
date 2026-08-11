import test from 'node:test';
import assert from 'node:assert/strict';
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
