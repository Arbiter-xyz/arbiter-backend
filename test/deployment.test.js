import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWriterLease,
  createAdminWriteGuard,
  createDrainController,
  createInFlightCounter,
  WRITER_LEASE_KEY,
  LeaseUnavailableError,
} from '../src/deployment.js';
import { createSerialQueue } from '../src/stellarClient.js';

// Same TTL/setNX semantics as store.js's MemoryStore, with an injectable
// clock so lease expiry is testable without waiting it out. Blue and green
// share one instance, the way both environments share one Redis.
function sharedStore(clock) {
  const map = new Map();
  const live = (key) => {
    const e = map.get(key);
    if (!e) return null;
    if (e.expiresAt && e.expiresAt < clock.now) {
      map.delete(key);
      return null;
    }
    return e;
  };
  return {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, ttlMs) {
      map.set(key, { value, expiresAt: ttlMs ? clock.now + ttlMs : null });
    },
    async setNX(key, value, ttlMs) {
      if (live(key)) return false;
      map.set(key, { value, expiresAt: ttlMs ? clock.now + ttlMs : null });
      return true;
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

// The contract's side of the overlap: resolve()/refund() on a question that
// is no longer Pending is rejected (QuestionNotPending), never paid twice.
function fakeContract() {
  const status = new Map();
  const signed = [];
  return {
    signed,
    open(qid) {
      status.set(qid, 'pending');
    },
    async invoke(signer, method, qid) {
      signed.push({ signer, method, qid });
      if (status.get(qid) !== 'pending') {
        const err = new Error('QuestionNotPending');
        err.code = 'QuestionNotPending';
        throw err;
      }
      status.set(qid, method === 'resolve' ? 'resolved' : 'refunded');
      return { signer, qid };
    },
    status: (qid) => status.get(qid),
  };
}

// One environment's admin-signing path: stellarClient.js's real serial queue
// with the write guard run inside it, exactly as invokeAsAdmin() does.
function environment(name, { store, clock, contract, waitMs = 5_000 }) {
  const lease = createWriterLease({ store, instanceId: name, ttlMs: 30_000, now: () => clock.now });
  const guard = createAdminWriteGuard(lease, { waitMs, pollMs: 5 });
  const serialize = createSerialQueue();
  return {
    name,
    lease,
    invoke: (method, qid, { beforeSign } = {}) =>
      serialize(async () => {
        await guard(method);
        if (beforeSign) await beforeSign();
        return contract.invoke(name, method, qid);
      }),
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(k, v) {
      this.headers[k] = v;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

describe('writer lease', () => {
  test('only one environment holds write authority at a time; release hands it over', async () => {
    const clock = { now: 1_000 };
    const store = sharedStore(clock);
    const blue = createWriterLease({ store, instanceId: 'blue', now: () => clock.now });
    const green = createWriterLease({ store, instanceId: 'green', now: () => clock.now });

    assert.equal(await blue.tryAcquire(), true);
    assert.equal(await green.tryAcquire(), false);
    assert.equal(await blue.tryAcquire(), true, 're-acquiring a lease you hold renews it');
    assert.equal(await green.release(), false, 'a non-holder cannot release');
    assert.equal((await store.get(WRITER_LEASE_KEY)).instanceId, 'blue');

    assert.equal(await blue.release(), true);
    assert.equal(await green.tryAcquire(), true);
    assert.equal(await blue.tryAcquire(), false);
  });

  test('a crashed holder never renews, so its lease expires and the standby takes over', async () => {
    const clock = { now: 1_000 };
    const store = sharedStore(clock);
    const blue = createWriterLease({ store, instanceId: 'blue', ttlMs: 30_000, now: () => clock.now });
    const green = createWriterLease({ store, instanceId: 'green', ttlMs: 30_000, now: () => clock.now });
    await blue.tryAcquire();
    clock.now += 29_000;
    assert.equal(await green.tryAcquire(), false);
    clock.now += 2_000;
    assert.equal(await green.tryAcquire(), true);
    assert.equal(await blue.renew(), false, 'the old holder learns it lost the lease');
  });

  test('a guard that never gets the lease fails with LeaseUnavailableError instead of signing', async () => {
    const clock = { now: 0 };
    const store = sharedStore(clock);
    await createWriterLease({ store, instanceId: 'blue' }).tryAcquire();
    const green = createWriterLease({ store, instanceId: 'green' });
    const guard = createAdminWriteGuard(green, { waitMs: 20, pollMs: 5 });
    await assert.rejects(guard(), (err) => err instanceof LeaseUnavailableError && err.holder.instanceId === 'blue');
  });
});

describe('blue-green cutover mid-settlement', () => {
  test('a settlement racing the cutover is signed exactly once; the only overlap symptom is QuestionNotPending', async () => {
    const clock = { now: 0 };
    const store = sharedStore(clock);
    const contract = fakeContract();
    const blue = environment('blue', { store, clock, contract });
    const green = environment('green', { store, clock, contract });
    contract.open('q1');
    contract.open('q2');

    // Blue holds the lease and is mid-settlement of q1 when cutover begins.
    let finishBlueSigning;
    const blueSigningHeld = new Promise((resolve) => (finishBlueSigning = resolve));
    let inFlight = 1;
    const blueSettle = blue.invoke('resolve', 'q1', { beforeSign: () => blueSigningHeld }).finally(() => (inFlight = 0));
    await tick();

    const drain = createDrainController({ countInFlight: async () => inFlight, onDrained: [() => blue.lease.release()], pollMs: 5 });
    const drained = drain.drain();

    // Green is live and (e.g. via reconciliation) tries to settle the same
    // question, plus a fresh one, while blue is still draining.
    const greenDuplicate = green.invoke('resolve', 'q1').catch((err) => err);
    const greenFresh = green.invoke('resolve', 'q2');
    await tick();
    assert.equal(contract.signed.length, 0, 'green must not sign anything while blue holds the lease');

    finishBlueSigning();
    await blueSettle;
    const report = await drained;
    assert.equal(report.drained, true);

    const duplicate = await greenDuplicate;
    await greenFresh;

    const successfulQ1 = contract.signed.filter((s) => s.qid === 'q1');
    assert.equal(successfulQ1[0].signer, 'blue', 'blue signed q1 first, before handing over');
    assert.equal(contract.status('q1'), 'resolved');
    assert.ok(duplicate instanceof Error && duplicate.code === 'QuestionNotPending', 'green\'s duplicate is rejected by the contract, not paid');
    assert.equal(contract.status('q2'), 'resolved');
    assert.equal(contract.signed.find((s) => s.qid === 'q2').signer, 'green');

    // Never two signers in flight at once: every green signature came after
    // blue's last one.
    const lastBlue = contract.signed.map((s) => s.signer).lastIndexOf('blue');
    const firstGreen = contract.signed.map((s) => s.signer).indexOf('green');
    assert.ok(lastBlue < firstGreen);
  });
});

describe('drain controller', () => {
  test('refuses new questions and flips readiness the moment a drain starts, then waits for in-flight jobs', async () => {
    let inFlight = 2;
    const started = [];
    const drained = [];
    const drain = createDrainController({
      countInFlight: async () => inFlight,
      onDrainStart: [() => started.push('sweeps stopped')],
      onDrained: [() => drained.push('lease released')],
      pollMs: 5,
    });

    let nextCalled = false;
    drain.rejectWhileDraining({}, fakeRes(), () => (nextCalled = true));
    assert.equal(nextCalled, true, 'serving: requests pass through');

    const done = drain.drain();
    assert.equal(drain.drain(), done, 'repeat calls join the same drain');
    const rejected = fakeRes();
    drain.rejectWhileDraining({}, rejected, () => assert.fail('must not reach the route'));
    assert.equal(rejected.statusCode, 503);
    assert.equal(rejected.headers['Retry-After'], '5');
    const ready = fakeRes();
    drain.readinessHandler({}, ready);
    assert.equal(ready.statusCode, 503);

    await tick();
    assert.deepEqual(started, ['sweeps stopped']);
    assert.deepEqual(drained, [], 'the lease is held until in-flight jobs finish');

    inFlight = 0;
    const report = await done;
    assert.equal(report.drained, true);
    assert.equal(report.stranded, 0);
    assert.deepEqual(drained, ['lease released']);
    assert.equal(drain.state, 'drained');
  });

  test('a drain that times out still releases the lease and names the stranded jobs', async () => {
    let released = false;
    const drain = createDrainController({
      countInFlight: async () => 3,
      onDrained: [() => (released = true)],
      timeoutMs: 20,
      pollMs: 5,
    });
    const report = await drain.drain();
    assert.equal(report.drained, false);
    assert.equal(report.stranded, 3);
    assert.equal(released, true, 'cutover always proceeds; the recovery sweep owns stranded escrow');
  });

  test('only process-bound jobs created by this instance count as in flight', async () => {
    const jobs = {
      a: { instanceId: 'blue', status: 'awaiting_workers' },
      b: { instanceId: 'blue', status: 'reconciling' },
      c: { instanceId: 'blue', status: 'settled' },
      d: { instanceId: 'blue', status: 'scheduled' },
      e: { instanceId: 'green', status: 'awaiting_workers' },
      f: { instanceId: 'blue', status: 'holding' },
    };
    const count = createInFlightCounter({
      getKnownJobIds: async () => [...Object.keys(jobs), 'expired'],
      getJob: async (id) => jobs[id] || null,
      instanceId: 'blue',
    });
    assert.equal(await count(), 3);
  });
});

describe('rollback', () => {
  test('green failing after cutover drains its own live-window jobs before blue takes the lease back', async () => {
    const clock = { now: 0 };
    const store = sharedStore(clock);
    const contract = fakeContract();
    const blue = environment('blue', { store, clock, contract });
    const green = environment('green', { store, clock, contract });

    // Cutover already happened: blue drained and released; green holds the
    // lease and accepted g1 during its live window.
    await green.lease.tryAcquire();
    contract.open('g1');
    let greenInFlight = 1;
    let finishG1;
    const g1Held = new Promise((resolve) => (finishG1 = resolve));
    const g1 = green.invoke('resolve', 'g1', { beforeSign: () => g1Held }).finally(() => (greenInFlight = 0));
    await tick();

    // Green fails its healthcheck: traffic goes back to blue, which resumes;
    // green is drained, not killed.
    const blueDrain = createDrainController({ countInFlight: async () => 0, pollMs: 5 });
    await blueDrain.drain();
    const greenDrain = createDrainController({
      countInFlight: async () => greenInFlight,
      onDrained: [() => green.lease.release()],
      pollMs: 5,
    });
    const greenDrained = greenDrain.drain();
    assert.equal(await blueDrain.resume(), true);

    contract.open('b1');
    const blueNext = blue.invoke('resolve', 'b1');
    await tick();
    assert.equal(contract.status('b1'), 'pending', 'blue waits for green to finish draining');

    finishG1();
    await g1;
    assert.equal((await greenDrained).drained, true);
    await blueNext;

    assert.equal(contract.status('g1'), 'resolved', 'the job created against green during its live window was not stranded');
    assert.equal(contract.signed.find((s) => s.qid === 'g1').signer, 'green');
    assert.equal(contract.status('b1'), 'resolved');
    assert.equal(contract.signed.find((s) => s.qid === 'b1').signer, 'blue');
  });
});
