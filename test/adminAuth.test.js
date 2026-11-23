import './helpers/admin-test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { requireAdmin, createInvoiceBilledAccount } from '../src/adminAuth.js';

function mockReqRes(authHeader) {
  const state = { statusCode: null, body: null, nextCalled: false };
  const req = { get: (name) => (name.toLowerCase() === 'authorization' ? authHeader : undefined) };
  const res = {
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(body) {
      state.body = body;
      return this;
    },
  };
  const next = () => {
    state.nextCalled = true;
  };
  return { req, res, next, state };
}

test('rejects a missing Authorization header', () => {
  const { req, res, next, state } = mockReqRes(undefined);
  requireAdmin(req, res, next);
  assert.equal(state.statusCode, 401);
  assert.equal(state.nextCalled, false);
});

test('rejects a wrong bearer token', () => {
  const { req, res, next, state } = mockReqRes('Bearer nope');
  requireAdmin(req, res, next);
  assert.equal(state.statusCode, 401);
  assert.equal(state.nextCalled, false);
});

test('calls next() for the correct bearer token', () => {
  const { req, res, next, state } = mockReqRes('Bearer test-admin-token');
  requireAdmin(req, res, next);
  assert.equal(state.nextCalled, true);
  assert.equal(state.statusCode, null);
});

test('accepts each of multiple configured admin tokens independently', () => {
  const tokens = ['tokenA', 'tokenB'];
  for (const token of tokens) {
    const { req, res, next, state } = mockReqRes(`Bearer ${token}`);
    requireAdmin(req, res, next);
    assert.equal(state.nextCalled, true, `expected ${token} to authenticate`);
    assert.equal(state.statusCode, null);
  }
});

test('rejects a token that is not in the configured list', () => {
  const { req, res, next, state } = mockReqRes('Bearer unlisted-token');
  requireAdmin(req, res, next);
  assert.equal(state.statusCode, 401);
  assert.equal(state.nextCalled, false);
});

test('createInvoiceBilledAccount rejects fractional, non-positive, or unsafe integer credit amounts before creating an account', async () => {
  let created = 0;
  const handler = createInvoiceBilledAccount({
    createAccount: async () => { created++; return { accountId: 'acct_1', apiKey: 'ak_1' }; },
    store: { incrBy: async () => {} },
  });
  for (const bad of [1.5, 0, -10, '1.25', Number.MAX_SAFE_INTEGER + 1, null, undefined, '']) {
    const { res, state } = mockReqRes(undefined);
    await handler({ body: { amount: bad } }, res);
    assert.equal(state.statusCode, 400, `expected 400 for amount=${bad}`);
  }
  assert.equal(created, 0);
});

test('createInvoiceBilledAccount rolls back the created account if store.incrBy fails', async () => {
  const deleted = [];
  const handler = createInvoiceBilledAccount({
    createAccount: async () => ({ accountId: 'acct_rollback', apiKey: 'ak_rollback' }),
    store: {
      incrBy: async () => { throw new Error('ERR value is not an integer or out of range'); },
      get: async (k) => (k === 'account-key:acct_rollback' ? 'hash_123' : null),
      delete: async (k) => { deleted.push(k); },
    },
  });
  const { res } = mockReqRes(undefined);
  await assert.rejects(() => handler({ body: { amount: 1000 } }, res), /not an integer/);
  assert.deepEqual(deleted, ['account:acct_rollback', 'account-key:acct_rollback', 'apikey:hash_123']);
});
