import test from 'node:test';
import assert from 'node:assert/strict';

import {
  probeStore,
  probeChain,
  probeJobs,
  startHealthProbes,
} from '../src/healthProbes.js';
import {
  storeUp,
  storeDurable,
  chainRpcUp,
  chainLatestLedger,
  onlineWorkers,
  jobsInflight,
  oldestInflightJobAge,
} from '../src/metrics.js';

async function gaugeValue(gauge, labels) {
  const metric = await gauge.get();
  if (!labels) return metric.values[0]?.value;
  const match = metric.values.find((v) =>
    Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return match?.value;
}

test('probeStore reports up=true, durable=false when store runs in-memory without a Redis client', async () => {
  const res = await probeStore({ getClient: () => null });
  assert.deepEqual(res, { up: true, durable: false });
  assert.equal(await gaugeValue(storeUp), 1);
  assert.equal(await gaugeValue(storeDurable), 0);
});

test('probeStore reports up=true, durable=true when Redis ping succeeds and up=false when ping fails', async () => {
  const okRes = await probeStore({
    getClient: () => ({ ping: async () => 'PONG' }),
  });
  assert.deepEqual(okRes, { up: true, durable: true });
  assert.equal(await gaugeValue(storeUp), 1);
  assert.equal(await gaugeValue(storeDurable), 1);

  const failRes = await probeStore({
    getClient: () => ({
      ping: async () => {
        throw new Error('ECONNREFUSED');
      },
    }),
  });
  assert.equal(failRes.up, false);
  assert.equal(failRes.durable, true);
  assert.match(failRes.error, /ECONNREFUSED/);
  assert.equal(await gaugeValue(storeUp), 0);
});

test('probeChain updates chainRpcUp and chainLatestLedger on success and records failure on error', async () => {
  const ok = await probeChain(async () => 456789);
  assert.deepEqual(ok, { up: true, sequence: 456789 });
  assert.equal(await gaugeValue(chainRpcUp), 1);
  assert.equal(await gaugeValue(chainLatestLedger), 456789);

  const fail = await probeChain(async () => {
    throw new Error('RPC 503');
  });
  assert.equal(fail.up, false);
  assert.match(fail.error, /RPC 503/);
  assert.equal(await gaugeValue(chainRpcUp), 0);
});

test('probeJobs fetches jobs in bounded concurrent batches and updates in-flight metrics', async () => {
  const now = 1_700_000_060_000;
  const totalJobs = 12;
  const batchSize = 4;
  const ids = Array.from({ length: totalJobs }, (_, i) => `job-${i}`);

  let active = 0;
  let maxConcurrent = 0;

  const jobsById = new Map(
    ids.map((id, idx) => [
      id,
      {
        id,
        status: idx === 0 ? 'collecting' : idx === 1 ? 'pending_review' : 'settled',
        createdAt: idx === 0 ? now - 45_000 : now - 10_000,
      },
    ]),
  );

  const res = await probeJobs(
    {
      getKnownJobIds: async () => ids,
      getJob: async (id) => {
        active += 1;
        if (active > maxConcurrent) maxConcurrent = active;
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return jobsById.get(id);
      },
    },
    now,
    { batchSize },
  );

  assert.deepEqual(res, { scanned: totalJobs });
  // Bounded batching: concurrency reaches batchSize (4) rather than sequential (1) or unbounded (12).
  assert.equal(maxConcurrent, batchSize);
  assert.equal(await gaugeValue(jobsInflight, { status: 'collecting' }), 1);
  assert.equal(await gaugeValue(jobsInflight, { status: 'pending_review' }), 1);
  assert.equal(await gaugeValue(oldestInflightJobAge), 45);
});

test('probeJobs catches errors from job store and returns error summary without throwing', async () => {
  const res = await probeJobs({
    getKnownJobIds: async () => {
      throw new Error('redis timeout');
    },
    getJob: async () => null,
  });
  assert.deepEqual(res, { error: 'redis timeout' });
});

test('startHealthProbes runs initial probes immediately, awaits async getOnlineWorkerCount, and stops cleanly', async () => {
  const stop = startHealthProbes({
    store: { getClient: () => ({ ping: async () => 'PONG' }) },
    getLatestLedgerSequence: async () => 777,
    getKnownJobIds: async () => [],
    getJob: async () => null,
    getOnlineWorkerCount: async () => 9,
    intervalMs: 60_000,
    jobScanIntervalMs: 60_000,
  });

  try {
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await gaugeValue(storeUp), 1);
    assert.equal(await gaugeValue(chainLatestLedger), 777);
    assert.equal(await gaugeValue(onlineWorkers), 9);
  } finally {
    stop();
  }
});
