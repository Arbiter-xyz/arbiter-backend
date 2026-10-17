import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';

import {
  AutoWithdrawError,
  DEFAULT_MIN_THRESHOLD_STROOPS,
  getAutoWithdrawSettings,
  setAutoWithdrawSettings,
  deleteAutoWithdrawSettings,
  checkAutoWithdraw,
  submitAutoWithdraw,
  sweepAutoWithdraw,
} from '../src/autoWithdraw.js';
import { store } from '../src/store.js';

const freshAddress = () => Keypair.random().publicKey();

test.beforeEach(async () => {
  await store.delete('auto-withdraw-workers');
});

test('setAutoWithdrawSettings validates inputs, normalizes self-beneficiary, and drops pending tx on term changes', async () => {
  const worker = freshAddress();
  const beneficiary = freshAddress();
  const minThreshold = DEFAULT_MIN_THRESHOLD_STROOPS;

  await assert.rejects(
    () => setAutoWithdrawSettings('bad-address', { thresholdStroops: minThreshold }),
    (err) => err instanceof AutoWithdrawError && err.status === 400,
  );

  await assert.rejects(
    () => setAutoWithdrawSettings(worker, { thresholdStroops: minThreshold - 1n }),
    (err) => err instanceof AutoWithdrawError && /at least/i.test(err.message),
  );

  // Self-beneficiary normalizes to null.
  const saved = await setAutoWithdrawSettings(worker, {
    enabled: true,
    thresholdStroops: minThreshold.toString(),
    beneficiaryAddress: worker,
  });
  assert.equal(saved.enabled, true);
  assert.equal(saved.beneficiaryAddress, null);

  // Seed a pending tx, then change beneficiary -> pending tx must be dropped.
  await store.set(`auto-withdraw-pending:${worker}`, {
    xdr: 'AAAA-OLD',
    amountStroops: minThreshold.toString(),
    beneficiaryAddress: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });

  await setAutoWithdrawSettings(worker, {
    enabled: true,
    thresholdStroops: minThreshold.toString(),
    beneficiaryAddress: beneficiary,
  });
  const afterChange = await getAutoWithdrawSettings(worker);
  assert.equal(afterChange.beneficiaryAddress, beneficiary);
  assert.equal(afterChange.pending, null);

  await deleteAutoWithdrawSettings(worker);
  const afterDelete = await getAutoWithdrawSettings(worker);
  assert.equal(afterDelete.enabled, false);
});

test('checkAutoWithdraw handles disabled, below_threshold, prepared, pending, and stale-pending states', async () => {
  const worker = freshAddress();
  const minThreshold = DEFAULT_MIN_THRESHOLD_STROOPS;

  assert.deepEqual(await checkAutoWithdraw(worker), { status: 'disabled' });

  await setAutoWithdrawSettings(worker, {
    enabled: true,
    thresholdStroops: (minThreshold * 2n).toString(),
  });

  // Below threshold
  const below = await checkAutoWithdraw(worker, {
    getOwed: async () => minThreshold,
  });
  assert.equal(below.status, 'below_threshold');

  // Reaches threshold -> prepares unsigned XDR and notifies worker
  const notifications = [];
  const prepared = await checkAutoWithdraw(worker, {
    getOwed: async () => minThreshold * 3n,
    buildWithdrawTx: async (addr, amount) => `XDR:${addr}:${amount}`,
    notify: async (addr, payload) => notifications.push({ addr, payload }),
  });
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.pending.amountStroops, (minThreshold * 3n).toString());
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].payload.type, 'auto_withdraw_ready');

  // Calling again while Owed >= pending.amountStroops returns existing pending
  const stillPending = await checkAutoWithdraw(worker, {
    getOwed: async () => minThreshold * 3n,
  });
  assert.equal(stillPending.status, 'pending');

  // If worker manually withdrew meanwhile so Owed < pending.amountStroops, stale pending is dropped
  const dropped = await checkAutoWithdraw(worker, {
    getOwed: async () => minThreshold,
  });
  assert.equal(dropped.status, 'below_threshold');
  assert.equal((await getAutoWithdrawSettings(worker)).pending, null);
});

test('submitAutoWithdraw relays via feeBumpWithdraw / feeBumpWithdrawTo and drops pending on relay failure', async () => {
  const worker = freshAddress();
  const beneficiary = freshAddress();
  const minThreshold = DEFAULT_MIN_THRESHOLD_STROOPS;

  await assert.rejects(
    () => submitAutoWithdraw(worker, 'SIGNED-XDR'),
    (err) => err instanceof AutoWithdrawError && err.status === 404,
  );

  // Direct withdraw (no beneficiary)
  await setAutoWithdrawSettings(worker, {
    enabled: true,
    thresholdStroops: minThreshold.toString(),
  });
  await checkAutoWithdraw(worker, {
    getOwed: async () => minThreshold,
    buildWithdrawTx: async () => 'UNSIGNED-1',
    notify: async () => {},
  });

  const recorded = [];
  const res1 = await submitAutoWithdraw(worker, 'SIGNED-1', {
    relayWithdraw: async (xdr, addr, amt) => {
      assert.equal(xdr, 'SIGNED-1');
      assert.equal(addr, worker);
      assert.equal(amt, minThreshold.toString());
      return { hash: 'tx-hash-direct' };
    },
    recordWithdrawal: async (addr, entry) => recorded.push({ addr, entry }),
  });
  assert.equal(res1.hash, 'tx-hash-direct');
  assert.equal(recorded.length, 1);
  assert.equal((await getAutoWithdrawSettings(worker)).pending, null);

  // Beneficiary withdraw + relay failure drops pending
  await setAutoWithdrawSettings(worker, {
    enabled: true,
    thresholdStroops: minThreshold.toString(),
    beneficiaryAddress: beneficiary,
  });
  await checkAutoWithdraw(worker, {
    getOwed: async () => minThreshold,
    buildWithdrawTx: async () => 'UNSIGNED-2',
    notify: async () => {},
  });

  await assert.rejects(
    () =>
      submitAutoWithdraw(worker, 'SIGNED-BAD', {
        relayWithdrawTo: async () => {
          throw new Error('tx_bad_seq');
        },
      }),
    (err) => err instanceof AutoWithdrawError && /tx_bad_seq/.test(err.message),
  );
  assert.equal((await getAutoWithdrawSettings(worker)).pending, null);
});

test('sweepAutoWithdraw checks opted-in workers in bounded concurrent batches (#287)', async () => {
  const minThreshold = DEFAULT_MIN_THRESHOLD_STROOPS;
  const workers = Array.from({ length: 9 }, () => freshAddress());
  for (const w of workers) {
    await setAutoWithdrawSettings(w, {
      enabled: true,
      thresholdStroops: minThreshold.toString(),
    });
  }

  let active = 0;
  let maxConcurrent = 0;

  const summary = await sweepAutoWithdraw({
    concurrency: 3,
    checkWorker: async (addr) => {
      active += 1;
      if (active > maxConcurrent) maxConcurrent = active;
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      if (addr === workers[0]) throw new Error('rpc timeout');
      return { status: addr === workers[1] ? 'prepared' : 'below_threshold' };
    },
  });

  assert.equal(maxConcurrent, 3);
  assert.deepEqual(summary, { checked: 8, prepared: 1, failed: 1 });
});
