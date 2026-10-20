import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSignerLock,
  createReadOnlyGate,
  createDrainController,
  deploymentFingerprint,
  comparePreflight,
  SignerLockError,
} from '../src/canary.js';

// setNX-with-TTL / get / delete, shared between "instances" the way one
// Redis is shared between two backend processes.
function sharedStore() {
  const map = new Map();
  return {
    map,
    getClient: () => null,
    async get(key) {
      return map.get(key)?.value ?? null;
    },
    async setNX(key, value) {
      if (map.has(key)) return false;
      map.set(key, { value });
      return true;
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a canary never signs: run() refuses before the signing function is invoked', async () => {
  const lock = createSignerLock({ store: sharedStore(), role: 'canary' });
  let signed = false;
  await assert.rejects(
    lock.run(async () => {
      signed = true;
    }),
    (err) => err instanceof SignerLockError && err.status === 503,
  );
  assert.equal(signed, false);
});

test('two primaries sharing a store never sign concurrently', async () => {
  const store = sharedStore();
  const a = createSignerLock({ store, instanceId: 'a', pollMs: 1, sleep: tick });
  const b = createSignerLock({ store, instanceId: 'b', pollMs: 1, sleep: tick });

  let active = 0;
  let maxActive = 0;
  const order = [];
  const sign = (name) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`${name}:start`);
    await tick();
    await tick();
    order.push(`${name}:end`);
    active -= 1;
    return name;
  };

  const results = await Promise.all([a.run(sign('a1')), b.run(sign('b1')), a.run(sign('a2')), b.run(sign('b2'))]);
  assert.deepEqual(results.sort(), ['a1', 'a2', 'b1', 'b2']);
  assert.equal(maxActive, 1);
  assert.equal(store.map.size, 0, 'lock released after the last call');
});

test('the lock is released even when the signing call fails', async () => {
  const store = sharedStore();
  const lock = createSignerLock({ store });
  await assert.rejects(lock.run(async () => Promise.reject(new Error('tx failed'))), /tx failed/);
  assert.equal(store.map.size, 0);
  assert.equal(await lock.run(async () => 'next'), 'next');
});

test('waiting for a lock another instance holds times out with a SignerLockError', async () => {
  const store = sharedStore();
  await store.setNX('lock:platform-signer', 'someone-else');
  let t = 0;
  const lock = createSignerLock({
    store,
    waitMs: 100,
    pollMs: 10,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  await assert.rejects(lock.run(async () => 'never'), SignerLockError);
});

test('release never deletes a lease that another instance acquired after ours expired', async () => {
  const store = sharedStore();
  const lock = createSignerLock({ store, instanceId: 'a' });
  await lock.run(async () => {
    // Our lease "expires" and instance b takes the lock mid-call.
    store.map.set('lock:platform-signer', { value: 'b:token' });
  });
  assert.equal(await store.get('lock:platform-signer'), 'b:token');
});

test('release uses an atomic compare-and-delete when the store has a Redis client', async () => {
  const store = sharedStore();
  const evals = [];
  store.getClient = () => ({ eval: async (...args) => evals.push(args) });
  const lock = createSignerLock({ store });
  await lock.run(async () => {});
  assert.equal(evals.length, 1);
  const [script, numKeys, key, token] = evals[0];
  assert.match(script, /redis\.call\('GET', KEYS\[1\]\) == ARGV\[1\]/);
  assert.equal(numKeys, 1);
  assert.equal(key, 'lock:platform-signer');
  assert.match(JSON.parse(token), /:/);
});

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) {
      this.headers[name] = value;
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

function runGate(gate, method, path) {
  const res = fakeRes();
  let passed = false;
  gate({ method, path }, res, () => {
    passed = true;
  });
  return { passed, res };
}

test('the canary gate serves only read paths and refuses everything else with a retryable 503', () => {
  const gate = createReadOnlyGate({ role: 'canary', readPaths: ['/leaderboard', '/stats'] });
  assert.equal(runGate(gate, 'GET', '/leaderboard').passed, true);
  assert.equal(runGate(gate, 'GET', '/stats').passed, true);

  for (const [method, path] of [
    ['POST', '/oracle'],
    ['GET', '/app/events'],
    ['POST', '/leaderboard'],
    ['GET', '/admin/workers'],
    ['POST', '/sponsor/withdraw'],
  ]) {
    const { passed, res } = runGate(gate, method, path);
    assert.equal(passed, false, `${method} ${path}`);
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['Retry-After'], '1');
    assert.equal(res.headers['X-Arbiter-Instance-Role'], 'canary');
  }
});

test('the gate is a no-op on a primary', () => {
  const gate = createReadOnlyGate({ role: 'primary', readPaths: [] });
  assert.equal(runGate(gate, 'POST', '/oracle').passed, true);
});

test('drain waits for every tracked fulfillment to settle, resolved or failed', async () => {
  let t = 0;
  const drain = createDrainController({ now: () => t, sleep: async (ms) => { t += ms; await tick(); }, pollMs: 10 });
  let finishA;
  let failB;
  drain.track(new Promise((resolve) => (finishA = resolve)));
  drain.track(new Promise((_, reject) => (failB = reject))).catch(() => {});
  assert.equal(drain.inFlightCount(), 2);

  drain.beginDrain();
  assert.equal(drain.isDraining(), true);
  const waiting = drain.waitForIdle({ timeoutMs: 10_000 });
  finishA();
  failB(new Error('settled via refund path'));
  assert.deepEqual(await waiting, { drained: true, inFlight: 0 });
});

test('drain honors minWaitMs for work not yet tracked, and reports a timeout honestly', async () => {
  let t = 0;
  const sleep = async (ms) => {
    t += ms;
  };
  const idle = createDrainController({ now: () => t, sleep, pollMs: 10 });
  assert.deepEqual(await idle.waitForIdle({ timeoutMs: 1_000, minWaitMs: 200 }), { drained: true, inFlight: 0 });
  assert.ok(t >= 200);

  t = 0;
  const stuck = createDrainController({ now: () => t, sleep, pollMs: 10 });
  stuck.track(new Promise(() => {}));
  assert.deepEqual(await stuck.waitForIdle({ timeoutMs: 100 }), { drained: false, inFlight: 1 });
});

const baseConfig = {
  canary: { role: 'primary' },
  contractId: 'CCONTRACT',
  contracts: [],
  platformAddress: 'GPLATFORM',
  networkPassphrase: 'Test SDF Network ; September 2015',
  compatibleContractVersion: 'v0.3.0',
};

test('preflight passes for a canary that matches the primary', () => {
  const primary = deploymentFingerprint({ config: baseConfig, instanceId: 'p', storeKind: 'redis', storeReachable: true });
  const canary = deploymentFingerprint({
    config: { ...baseConfig, canary: { role: 'canary' } },
    instanceId: 'c',
    storeKind: 'redis',
    storeReachable: true,
  });
  assert.equal(canary.role, 'canary');
  assert.deepEqual(comparePreflight(primary, canary), []);
});

test('preflight catches a canary pointed at the wrong environment', () => {
  const primary = deploymentFingerprint({ config: baseConfig, instanceId: 'p', storeKind: 'redis', storeReachable: true });
  const wrong = deploymentFingerprint({
    config: { ...baseConfig, contractId: 'COTHER', platformAddress: 'GOTHER', networkPassphrase: 'Public Global Stellar Network ; September 2015' },
    instanceId: 'c',
    storeKind: 'redis',
    storeReachable: false,
  });
  const problems = comparePreflight(primary, wrong).join('\n');
  assert.match(problems, /contractId differs/);
  assert.match(problems, /platformAddress differs/);
  assert.match(problems, /networkPassphrase differs/);
  assert.match(problems, /canary cannot reach Redis/);
});

test('preflight refuses in-memory stores and two URLs that reach the same instance', () => {
  const fp = deploymentFingerprint({ config: baseConfig, instanceId: 'same', storeKind: 'memory', storeReachable: true });
  const problems = comparePreflight(fp, fp).join('\n');
  assert.match(problems, /primary is not using Redis/);
  assert.match(problems, /same instance/);
  assert.deepEqual(comparePreflight(fp, null), ['canary /health did not report a deployment fingerprint']);
});
