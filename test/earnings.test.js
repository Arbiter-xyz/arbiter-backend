import test from 'node:test';
import assert from 'node:assert/strict';

import {
  workerShareStroops,
  recordWorkerCredits,
  recordWorkerWithdrawal,
  getWorkerCredits,
  getWorkerWithdrawals,
  getWorkerEarningYears,
  getEarnersForYear,
} from '../src/earnings.js';

test('workerShareStroops deducts 20% platform fee and integer-divides remainder across matching workers', () => {
  // 10_000_000 stroops (1 USDC) -> 20% fee = 2_000_000 -> net 8_000_000 -> 3 workers = 2_666_666 each (2 remainder stroops stay in contract)
  assert.equal(workerShareStroops(10_000_000n, 3), 2_666_666n);
  assert.equal(workerShareStroops('5000000', 2), 2_000_000n);
  assert.equal(workerShareStroops(10_000_000n, 0), 0n);
  assert.equal(workerShareStroops(10_000_000n, -2), 0n);
  assert.equal(workerShareStroops(0n, 3), 0n);
});

test('recordWorkerCredits and recordWorkerWithdrawal bucket by UTC year and deduplicate re-driven settlements', async () => {
  const w1 = `GWORKER1_${Date.now()}`;
  const w2 = `GWORKER2_${Date.now()}`;
  const ts2025 = Date.UTC(2025, 5, 15, 12, 0, 0);
  const ts2026 = Date.UTC(2026, 1, 10, 8, 30, 0);

  await recordWorkerCredits('q-101', [w1, w2], 10_000_000n, 'tx-settle-101', ts2025);
  // Re-driving the same questionId for the same workers must be idempotent
  await recordWorkerCredits('q-101', [w1, w2], 10_000_000n, 'tx-settle-101-dup', ts2025);

  const credits2025 = await getWorkerCredits(w1, 2025);
  assert.equal(credits2025.length, 1);
  assert.equal(credits2025[0].questionId, 'q-101');
  assert.equal(credits2025[0].amountStroops, '4000000');
  assert.equal(credits2025[0].grossQuestionStroops, '10000000');
  assert.equal(credits2025[0].payoutTx, 'tx-settle-101');

  await recordWorkerWithdrawal(
    w1,
    { amountStroops: '4000000', txHash: 'tx-withdraw-1', beneficiaryAddress: null, auto: true },
    ts2026,
  );
  // Duplicate txHash is ignored
  await recordWorkerWithdrawal(
    w1,
    { amountStroops: '4000000', txHash: 'tx-withdraw-1', beneficiaryAddress: null, auto: true },
    ts2026,
  );

  const withdrawals2026 = await getWorkerWithdrawals(w1, 2026);
  assert.equal(withdrawals2026.length, 1);
  assert.equal(withdrawals2026[0].txHash, 'tx-withdraw-1');
  assert.equal(withdrawals2026[0].auto, true);

  assert.deepEqual(await getWorkerEarningYears(w1), [2025, 2026]);
  const earners2025 = await getEarnersForYear(2025);
  assert.equal(earners2025.includes(w1), true);
  assert.equal(earners2025.includes(w2), true);
});
