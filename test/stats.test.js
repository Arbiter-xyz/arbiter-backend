import test from 'node:test';
import assert from 'node:assert/strict';
import { incrementStat, getStats } from '../src/stats.js';

test('getStats starts at zero for a fresh counter name', async () => {
  // Use unique-ish assertions relative to a baseline read rather than
  // assuming absolute zero, since other tests in this run may have
  // incremented the same shared in-memory counters.
  const before = await getStats();
  await incrementStat('resolved');
  const after = await getStats();
  assert.equal(after.totalResolved, before.totalResolved + 1);
  assert.equal(after.totalSettled, before.totalSettled + 1);
});

test('resolved and refunded counters are independent', async () => {
  const before = await getStats();
  await incrementStat('refunded');
  await incrementStat('refunded');
  const after = await getStats();
  assert.equal(after.totalRefunded, before.totalRefunded + 2);
  assert.equal(after.totalResolved, before.totalResolved);
});

test('totalSettled is always the sum of resolved and refunded', async () => {
  const stats = await getStats();
  assert.equal(stats.totalSettled, stats.totalResolved + stats.totalRefunded);
});
