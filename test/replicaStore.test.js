import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplicaReadStore, parseReplicationInfo } from '../src/replicaStore.js';

function kv(entries = {}, { failing = false } = {}) {
  const map = new Map(Object.entries(entries));
  const calls = { get: 0, hgetall: 0 };
  return {
    map,
    calls,
    failing,
    async get(key) {
      calls.get += 1;
      if (this.failing) throw new Error('replica connection refused');
      return map.has(key) ? map.get(key) : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async hgetall(key) {
      calls.hgetall += 1;
      if (this.failing) throw new Error('replica connection refused');
      return map.get(key) || {};
    },
  };
}

test('with no replica configured, every read goes to the primary (today’s behavior)', async () => {
  const primary = kv({ 'known-job-ids': ['1', '2'] });
  const view = createReplicaReadStore({ primary });
  assert.deepEqual(await view.get('known-job-ids'), ['1', '2']);
  assert.equal(primary.calls.get, 1);
  assert.equal((await view.status()).configured, false);
  assert.equal((await view.status()).source, 'primary');
});

test('with a replica configured, reads come exclusively from the replica', async () => {
  // Distinct instances: the replica has its own (lagging) copy of the data.
  const primary = kv({ 'job:1': { status: 'settled' } });
  const replica = kv({ 'job:1': { status: 'awaiting_workers' } });
  const view = createReplicaReadStore({ primary, replica });

  assert.deepEqual(await view.get('job:1'), { status: 'awaiting_workers' });
  assert.deepEqual(await view.hgetall('h'), {});
  assert.equal(primary.calls.get + primary.calls.hgetall, 0);
  assert.equal(replica.calls.get, 1);
});

test('primary writes still land on the primary while admin reads use the replica', async () => {
  const primary = kv();
  const replica = kv({ 'known-payer-addresses': ['GOLD'] });
  const view = createReplicaReadStore({ primary, replica });

  await primary.set('known-payer-addresses', ['GNEW', 'GOLD']); // settlement path writes the primary
  assert.deepEqual(primary.map.get('known-payer-addresses'), ['GNEW', 'GOLD']);
  assert.deepEqual(await view.get('known-payer-addresses'), ['GOLD']); // replica not yet caught up
  assert.equal(replica.map.has('GNEW'), false);
});

test('the view is read-only: no write methods exist to send to a replica', () => {
  const view = createReplicaReadStore({ primary: kv(), replica: kv() });
  for (const method of ['set', 'delete', 'setNX', 'incr', 'incrBy', 'hsetnx', 'decrIfAtLeast']) {
    assert.equal(view[method], undefined, method);
  }
  assert.throws(() => {
    view.set = () => {};
  }, TypeError);
});

test('a failing replica degrades to primary reads instead of failing the request', async () => {
  let t = 0;
  const warnings = [];
  const primary = kv({ k: 'from-primary' });
  const replica = kv({ k: 'from-replica' }, { failing: true });
  const view = createReplicaReadStore({
    primary,
    replica,
    retryAfterMs: 1_000,
    now: () => t,
    logger: { warn: (obj, msg) => warnings.push(msg) },
  });

  assert.equal(await view.get('k'), 'from-primary');
  assert.equal(warnings.length, 1);
  const status = await view.status();
  assert.equal(status.source, 'primary');
  assert.match(status.lastError.message, /connection refused/);

  // Within the back-off window the replica isn't even tried.
  assert.equal(await view.get('k'), 'from-primary');
  assert.equal(replica.calls.get, 1);

  // After it, the replica is retried, and used again once it recovers.
  replica.failing = false;
  t = 1_000;
  assert.equal(await view.get('k'), 'from-replica');
  assert.equal((await view.status()).source, 'replica');
});

test('status() reports replica lag from INFO replication when the client supports it', async () => {
  const replica = kv();
  replica.getClient = () => ({
    info: async () => '# Replication\r\nrole:slave\r\nmaster_link_status:up\r\nmaster_last_io_seconds_ago:3\r\n',
  });
  const status = await createReplicaReadStore({ primary: kv(), replica }).status();
  assert.equal(status.lagSeconds, 3);
  assert.equal(status.linkUp, true);
  assert.equal(status.role, 'slave');
});

test('status() never throws when the lag probe fails', async () => {
  const replica = kv();
  replica.getClient = () => ({
    info: async () => {
      throw new Error('boom');
    },
  });
  const status = await createReplicaReadStore({ primary: kv(), replica }).status();
  assert.equal(status.lagSeconds, null);
  assert.equal(status.configured, true);
});

test('parseReplicationInfo reports a down link as unknown lag', () => {
  assert.deepEqual(parseReplicationInfo('role:slave\nmaster_link_status:down\nmaster_last_io_seconds_ago:-1\n'), {
    role: 'slave',
    linkUp: false,
    lastIoSecondsAgo: null,
  });
  assert.deepEqual(parseReplicationInfo(''), { role: null, linkUp: null, lastIoSecondsAgo: null });
});
