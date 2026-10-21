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

test('toLeaderboardV2 renders matchRatioPct: null (not 0) for a worker with no answers', () => {
  const v2 = toLeaderboardV2([
    { workerId: 'fresh', matched: 0, totalAnswers: 0, matchRatio: null, stakeStroops: '0', stake: '0', established: false },
    { workerId: 'zero-acc', matched: 0, totalAnswers: 4, matchRatio: 0, stakeStroops: '0', stake: '0', established: true },
    { workerId: 'half', matched: 1, totalAnswers: 2, matchRatio: 0.5, stakeStroops: '0', stake: '0', established: true },
  ]);
  assert.equal(v2.apiVersion, 'v2');
  assert.equal(v2.workers[0].matchRatioPct, null);
  assert.equal(v2.workers[1].matchRatioPct, 0);
  assert.equal(v2.workers[2].matchRatioPct, 50);
  assert.deepEqual(v2.workers.map((w) => w.rank), [1, 2, 3]);
});
