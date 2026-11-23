import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import {
  verifySession,
  revokeSession,
  mountSessionRoutes,
} from '../src/workerAuth.js';

// In-memory store stub matching the subset of the store API used by
// workerAuth (get/set with optional TTL).
function createMemoryStore() {
  const data = new Map();
  return {
    async get(key) {
      const entry = data.get(key);
      if (!entry) return null;
      if (entry.expiresAt && entry.expiresAt <= Date.now()) {
        data.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds) {
      const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
      data.set(key, { value, expiresAt });
      return 'OK';
    },
    _raw: data,
  };
}

// Build a session token in the same shape parseSessionToken expects.
function makeToken(address, sid, ttlSeconds = 3600) {
  const payload = {
    address,
    sid,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

test('fresh token verifies and stops verifying after revokeSession', async () => {
  const store = createMemoryStore();
  const token = makeToken('GADDRESS1', 'sid-1');

  assert.equal(await verifySession(token, store), 'GADDRESS1');

  const revoked = await revokeSession(token, store);
  assert.equal(revoked, 'GADDRESS1');

  assert.equal(await verifySession(token, store), null);
});

test('revoking twice returns null the second time', async () => {
  const store = createMemoryStore();
  const token = makeToken('GADDRESS2', 'sid-2');

  assert.equal(await revokeSession(token, store), 'GADDRESS2');
  assert.equal(await revokeSession(token, store), null);
});

test('revocation marker TTL equals remaining token lifetime', async () => {
  const store = createMemoryStore();
  const ttlSeconds = 120;
  const token = makeToken('GADDRESS3', 'sid-3', ttlSeconds);

  await revokeSession(token, store);

  const marker = store._raw.get('revoked:sid-3');
  assert.ok(marker, 'expected a revocation marker to be stored');
  const remaining = Math.round((marker.expiresAt - Date.now()) / 1000);
  assert.ok(
    Math.abs(remaining - ttlSeconds) <= 2,
    `expected TTL ~${ttlSeconds}s, got ${remaining}s`,
  );
});

test('revoke route returns 401 for a token of another address', async () => {
  const store = createMemoryStore();
  const app = express();
  app.use(express.json());
  mountSessionRoutes(app, '/worker', store);

  const server = app.listen(0);
  try {
    const { port } = server.address();
    const token = makeToken('GOTHER', 'sid-4');
    const res = await fetch(
      `http://127.0.0.1:${port}/worker/GADDRESS4/session/revoke`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      },
    );
    assert.equal(res.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
