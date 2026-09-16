import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiKey, hashApiKey } from '../src/apiKeyAuth.js';
import { store } from '../src/store.js';

function mockReq(authHeader) {
  return { get: (name) => (name.toLowerCase() === 'authorization' ? authHeader : undefined) };
}

test('resolveApiKey resolves a valid key to its accountId', async () => {
  const rawKey = 'ak_live_' + 'a'.repeat(64);
  await store.set(`apikey:${hashApiKey(rawKey)}`, { accountId: 'acct_test1' });

  assert.equal(await resolveApiKey(mockReq(`Bearer ${rawKey}`)), 'acct_test1');
});

test('resolveApiKey returns null for a well-formed but unknown key', async () => {
  assert.equal(await resolveApiKey(mockReq(`Bearer ak_live_${'b'.repeat(64)}`)), null);
});

test('resolveApiKey returns null for a missing Authorization header', async () => {
  assert.equal(await resolveApiKey(mockReq(undefined)), null);
});

test('resolveApiKey returns null for a non-Bearer scheme or a key missing the ak_live_ prefix', async () => {
  assert.equal(await resolveApiKey(mockReq('Basic dXNlcjpwYXNz')), null);
  assert.equal(await resolveApiKey(mockReq('Bearer some-other-token')), null);
});

test('the raw key is never what gets stored — only its hash is a valid lookup', async () => {
  const rawKey = 'ak_live_' + 'c'.repeat(64);
  const hash = hashApiKey(rawKey);
  await store.set(`apikey:${hash}`, { accountId: 'acct_test2' });

  assert.notEqual(hash, rawKey);
  assert.equal(await store.get(`apikey:${rawKey}`), null); // the raw key itself is not a key in the store
});
