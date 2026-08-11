import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../src/reconcile.js';

function established(workerId, answer) {
  return { workerId, answer, established: true };
}

function fresh(workerId, answer) {
  return { workerId, answer, established: false };
}

test('no submissions forces a refund path with zero confidence', async () => {
  const result = await reconcile('Q?', []);
  assert.equal(result.method, 'no-answers');
  assert.equal(result.confidence, 0);
  assert.deepEqual(result.matchingWorkerIds, []);
});

test('unanimous exact-match answers from established workers take the fast path and skip Claude entirely', async () => {
  const result = await reconcile('What is 2+2?', [established('w1', '4'), established('w2', '  4 '), established('w3', '4')]);
  assert.equal(result.method, 'exact-match-fastpath');
  assert.equal(result.confidence, 1);
  assert.deepEqual(result.matchingWorkerIds.sort(), ['w1', 'w2', 'w3']);
  assert.equal(result.consensus, '4');
});

test('case/punctuation/whitespace differences still count as an exact-match agreement', async () => {
  const result = await reconcile('Capital of France?', [
    established('w1', 'Paris'),
    established('w2', 'paris.'),
    established('w3', '  PARIS  '),
  ]);
  assert.equal(result.method, 'exact-match-fastpath');
  assert.equal(result.confidence, 1);
});

test('unanimous agreement from FRESH (unestablished) workers does NOT take the fast path, even though it agrees perfectly', async () => {
  // A quorum of brand-new identities racing to submit the same answer is
  // exactly the sybil scenario the fast path must not rubber-stamp — it
  // must fall through to Claude (or the deterministic fallback, since no
  // ANTHROPIC_API_KEY is configured in this test environment) instead of
  // auto-accepting on structural agreement alone.
  const result = await reconcile('What is 2+2?', [fresh('sybil1', '4'), fresh('sybil2', '4'), fresh('sybil3', '4')]);
  assert.notEqual(result.method, 'exact-match-fastpath');
  assert.equal(result.method, 'exact-match-fallback');
});

test('a mix of established and fresh workers agreeing unanimously still requires the non-fast-path (any fresh worker forces review)', async () => {
  const result = await reconcile('What is 2+2?', [established('w1', '4'), established('w2', '4'), fresh('newcomer', '4')]);
  assert.notEqual(result.method, 'exact-match-fastpath');
});

test('genuine disagreement without an API key falls back to a deterministic plurality vote, never throws', async () => {
  const result = await reconcile('Best programming language?', [
    established('w1', 'Rust'),
    established('w2', 'Rust'),
    established('w3', 'Python'),
  ]);
  // No ANTHROPIC_API_KEY configured in this test environment, so reconcile()
  // must fall back to the exact-match vote rather than hang or throw.
  assert.equal(result.method, 'exact-match-fallback');
  assert.equal(result.consensus, 'Rust');
  assert.ok(Math.abs(result.confidence - 2 / 3) < 1e-9);
  assert.deepEqual(result.matchingWorkerIds.sort(), ['w1', 'w2']);
});
