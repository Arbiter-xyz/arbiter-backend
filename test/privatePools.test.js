import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import {
  getPrivatePool,
  addPoolWorkers,
  removePoolWorkers,
  getKnownPoolOwners,
  PoolValidationError,
  MAX_POOL_SIZE,
} from '../src/privatePools.js';

const addr = () => Keypair.random().publicKey();

test('a payer with no registered pool has an empty pool', async () => {
  assert.deepEqual(await getPrivatePool(addr()), []);
  assert.deepEqual(await getPrivatePool(null), []);
});

test('added workers are listed newest-first, and re-adding one does not duplicate it', async () => {
  const payer = addr();
  const [w1, w2, w3] = [addr(), addr(), addr()];
  await addPoolWorkers(payer, [w1]);
  await addPoolWorkers(payer, [w2, w3]);
  await addPoolWorkers(payer, [w1, w2]);

  assert.deepEqual(await getPrivatePool(payer), [w2, w3, w1]);
});

test('duplicates within a single add call are collapsed', async () => {
  const payer = addr();
  const w = addr();
  assert.deepEqual(await addPoolWorkers(payer, [w, w, w]), [w]);
});

test('removing a worker drops only that worker', async () => {
  const payer = addr();
  const [w1, w2] = [addr(), addr()];
  await addPoolWorkers(payer, [w1, w2]);
  assert.deepEqual(await removePoolWorkers(payer, [w1]), [w2]);
  assert.deepEqual(await getPrivatePool(payer), [w2]);
});

test('removing a worker who is not in the pool is a no-op', async () => {
  const payer = addr();
  const w = addr();
  await addPoolWorkers(payer, [w]);
  assert.deepEqual(await removePoolWorkers(payer, [addr()]), [w]);
});

test('removing the last worker deletes the pool, so the payer is back on the open pool', async () => {
  const payer = addr();
  const w = addr();
  await addPoolWorkers(payer, [w]);
  await removePoolWorkers(payer, [w]);
  assert.deepEqual(await getPrivatePool(payer), []);
});

test('pools of different payers are independent', async () => {
  const [payerA, payerB] = [addr(), addr()];
  const [wa, wb] = [addr(), addr()];
  await addPoolWorkers(payerA, [wa]);
  await addPoolWorkers(payerB, [wb]);
  assert.deepEqual(await getPrivatePool(payerA), [wa]);
  assert.deepEqual(await getPrivatePool(payerB), [wb]);
});

test('an address that has never connected or answered can be pre-registered', async () => {
  // Deliberate: requiring getKnownWorkerIds() membership would make a brand-new
  // team member impossible to add (see privatePools.js).
  const payer = addr();
  const neverSeen = addr();
  assert.deepEqual(await addPoolWorkers(payer, [neverSeen]), [neverSeen]);
});

test('non-address worker ids are rejected, and nothing from the batch is stored', async () => {
  const payer = addr();
  const good = addr();
  await assert.rejects(addPoolWorkers(payer, [good, 'demo-worker-1']), PoolValidationError);
  await assert.rejects(addPoolWorkers(payer, ['GNOTAREALADDRESS']), PoolValidationError);
  await assert.rejects(addPoolWorkers(payer, [42]), PoolValidationError);
  assert.deepEqual(await getPrivatePool(payer), []);
});

test('empty or non-array input is rejected', async () => {
  const payer = addr();
  await assert.rejects(addPoolWorkers(payer, []), PoolValidationError);
  await assert.rejects(addPoolWorkers(payer, addr()), PoolValidationError);
  await assert.rejects(removePoolWorkers(payer, undefined), PoolValidationError);
});

test('a pool cannot grow past MAX_POOL_SIZE, and an over-limit add is rejected whole rather than truncated', async () => {
  const payer = addr();
  const full = Array.from({ length: MAX_POOL_SIZE }, addr);
  await addPoolWorkers(payer, full);
  await assert.rejects(addPoolWorkers(payer, [addr()]), /at most/);
  assert.equal((await getPrivatePool(payer)).length, MAX_POOL_SIZE);
  // Re-adding an existing member still works at the limit.
  assert.equal((await addPoolWorkers(payer, [full[0]])).length, MAX_POOL_SIZE);
});

test('pool owners are recorded in the durable owner index once', async () => {
  const payer = addr();
  await addPoolWorkers(payer, [addr()]);
  await addPoolWorkers(payer, [addr()]);
  const owners = await getKnownPoolOwners();
  assert.equal(owners.filter((o) => o === payer).length, 1);
});
