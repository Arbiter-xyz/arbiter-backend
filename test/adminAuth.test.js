import './helpers/admin-test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { requireAdmin } from '../src/adminAuth.js';

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
