import test from 'node:test';
import assert from 'node:assert/strict';
import { rankLeaderboard, toLeaderboardV2 } from '../src/leaderboard.js';

function row(workerId, matched, total, established = true) {
  return { workerId, matched, totalAnswers: total, matchRatio: matched / total, established };
}

test('ranks by match ratio descending', () => {
  const rows = [row('low', 5, 10), row('high', 9, 10), row('mid', 7, 10)];
  const ranked = rankLeaderboard(rows);
  assert.deepEqual(
    ranked.map((r) => r.workerId),
    ['high', 'mid', 'low'],
  );
});

test('ties in match ratio break by sample size (more history ranks higher)', () => {
  const rows = [row('small-sample', 5, 10), row('big-sample', 50, 100)];
  const ranked = rankLeaderboard(rows);
  assert.deepEqual(
    ranked.map((r) => r.workerId),
    ['big-sample', 'small-sample'],
  );
});

test('non-established workers never appear, regardless of a perfect ratio', () => {
  const rows = [row('fresh-perfect', 1, 1, false), row('established-ok', 8, 10, true)];
  const ranked = rankLeaderboard(rows);
  assert.deepEqual(
    ranked.map((r) => r.workerId),
    ['established-ok'],
  );
});

test('respects the limit', () => {
  const rows = [row('a', 9, 10), row('b', 8, 10), row('c', 7, 10)];
  const ranked = rankLeaderboard(rows, 2);
  assert.equal(ranked.length, 2);
});

test('empty input returns an empty leaderboard, not a throw', () => {
  assert.deepEqual(rankLeaderboard([]), []);
});

test('toLeaderboardV2 preserves null matchRatio as matchRatioPct: null instead of coercing to 0 (#317)', () => {
  const v2 = toLeaderboardV2([
    {
      workerId: 'no-answers-yet',
      totalAnswers: 0,
      matched: 0,
      matchRatio: null,
      stakeStroops: '50000000',
      stake: 5,
      established: false,
    },
    {
      workerId: 'undefined-ratio',
      totalAnswers: 0,
      matched: 0,
      matchRatio: undefined,
      stakeStroops: '0',
      stake: 0,
      established: false,
    },
    {
      workerId: 'zero-accuracy',
      totalAnswers: 10,
      matched: 0,
      matchRatio: 0,
      stakeStroops: '10000000',
      stake: 1,
      established: true,
    },
    {
      workerId: 'two-thirds',
      totalAnswers: 3,
      matched: 2,
      matchRatio: 2 / 3,
      stakeStroops: '25000000',
      stake: 2.5,
      established: true,
    },
  ]);

  assert.equal(v2.apiVersion, 'v2');
  assert.equal(v2.workers.length, 4);

  assert.equal(v2.workers[0].rank, 1);
  assert.strictEqual(v2.workers[0].matchRatioPct, null);
  assert.deepEqual(v2.workers[0].stake, { stroops: '50000000', usdc: 5 });

  assert.equal(v2.workers[1].rank, 2);
  assert.strictEqual(v2.workers[1].matchRatioPct, null);

  assert.equal(v2.workers[2].rank, 3);
  assert.strictEqual(v2.workers[2].matchRatioPct, 0);

  assert.equal(v2.workers[3].rank, 4);
  assert.strictEqual(v2.workers[3].matchRatioPct, 67);
});

