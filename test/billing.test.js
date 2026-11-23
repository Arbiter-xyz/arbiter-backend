import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAccount,
  rotateApiKey,
  restoreCredit,
  resolveApiKey,
  resolveCurrency,
} from '../src/billing.js';
import { store } from '../src/store.js';

test('createAccount key resolves via resolveApiKey', async () => {
  const { accountId, rawKey } = await createAccount();
  assert.ok(accountId);
  assert.ok(rawKey);

  const resolved = await resolveApiKey(rawKey);
  assert.equal(resolved, accountId);
});

test('rotateApiKey invalidates old key and activates new key', async () => {
  const { accountId, rawKey: oldKey } = await createAccount();

  const { rawKey: newKey } = await rotateApiKey(accountId);
  assert.ok(newKey);
  assert.notEqual(newKey, oldKey);

  assert.equal(await resolveApiKey(oldKey), null);
  assert.equal(await resolveApiKey(newKey), accountId);
});

test('restoreCredit with 0 or negative stroops is a no-op', async () => {
  const { accountId } = await createAccount();
  await store.incrBy(`credit:${accountId}`, 500);

  await restoreCredit(accountId, 0);
  await restoreCredit(accountId, -100);

  const credit = await store.get(`credit:${accountId}`);
  assert.equal(Number(credit), 500);
});

test('resolveCurrency accepts USD and padded/lowercased usd', () => {
  const upper = resolveCurrency('USD');
  assert.equal(upper.code, 'usd');

  const padded = resolveCurrency(' usd ');
  assert.equal(padded.code, 'usd');
  assert.deepEqual(padded, upper);
});

test('resolveCurrency rejects unsupported or malformed codes', () => {
  assert.throws(() => resolveCurrency('eur'), /unsupported currency/);
  assert.throws(() => resolveCurrency('us'), /unsupported currency/);
  assert.throws(() => resolveCurrency('12a'), /unsupported currency/);
});
