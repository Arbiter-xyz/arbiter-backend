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

test('accepts a lowercase bearer scheme', () => {
  const { req, res, next, state } = mockReqRes('bearer test-admin-token');
  requireAdmin(req, res, next);
  assert.equal(state.nextCalled, true);
  assert.equal(state.statusCode, null);
});

test('accepts a mixed-case bearer scheme with extra whitespace', () => {
  const { req, res, next, state } = mockReqRes('BeArEr   test-admin-token');
  requireAdmin(req, res, next);
  assert.equal(state.nextCalled, true);
  assert.equal(state.statusCode, null);
});

function mockProvisionReqRes(body) {
  const state = { statusCode: null, body: null };
  const req = { body };
  const res = {
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(payload) {
      state.body = payload;
      return this;
    },
  };
  return { req, res, state };
}

function makeStore({ incrByImpl } = {}) {
  const calls = { incrBy: [], del: [] };
  return {
    calls,
    async incrBy(key, delta) {
      calls.incrBy.push([key, delta]);
      if (incrByImpl) return incrByImpl(key, delta);
      return delta;
    },
    async del(key) {
      calls.del.push(key);
      return 1;
    },
  };
}

test('createInvoiceBilledAccount rejects fractional amounts without creating an account', async () => {
  let created = 0;
  const createAccount = async () => {
    created += 1;
    return { accountId: 'acct-1', apiKey: 'key-1' };
  };
  const store = makeStore();
  const handler = createInvoiceBilledAccount({ createAccount, store });
  const { req, res, state } = mockProvisionReqRes({ amount: 1.5 });
  await handler(req, res);
  assert.equal(state.statusCode, 400);
  assert.equal(created, 0);
  assert.deepEqual(store.calls.incrBy, []);
});

test('createInvoiceBilledAccount rejects huge amounts without creating an account', async () => {
  let created = 0;
  const createAccount = async () => {
    created += 1;
    return { accountId: 'acct-1', apiKey: 'key-1' };
  };
  const store = makeStore();
  const handler = createInvoiceBilledAccount({ createAccount, store });
  const { req, res, state } = mockProvisionReqRes({ amount: Number.MAX_SAFE_INTEGER + 10 });
  await handler(req, res);
  assert.equal(state.statusCode, 400);
  assert.equal(created, 0);
  assert.deepEqual(store.calls.incrBy, []);
});

test('createInvoiceBilledAccount rolls back the account when crediting fails', async () => {
  const createAccount = async () => ({ accountId: 'acct-rollback', apiKey: 'key-rollback' });
  const store = makeStore({
    incrByImpl: async () => {
      throw new Error('INCRBY failed');
    },
  });
  const handler = createInvoiceBilledAccount({ createAccount, store });
  const { req, res, state } = mockProvisionReqRes({ amount: 10 });
  await handler(req, res);
  assert.deepEqual(store.calls.del, ['credit:acct-rollback']);
  assert.equal(state.statusCode, 500);
});
