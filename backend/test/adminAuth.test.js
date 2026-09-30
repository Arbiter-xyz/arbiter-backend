const { test } = require('node:test');
const assert = require('node:assert');
const { requireAdmin } = require('../src/adminAuth');
const config = require('../src/config');

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

test('rejects missing Authorization header', () => {
  const req = { headers: {} };
  const res = mockRes();
  let nextCalled = false;
  requireAdmin(req, res, () => {
    nextCalled = true;
  });
  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(res.body, { error: 'unauthorized' });
  assert.strictEqual(nextCalled, false);
});

test('rejects non-Bearer scheme', () => {
  const req = { headers: { authorization: `Basic ${config.admin.token}` } };
  const res = mockRes();
  let nextCalled = false;
  requireAdmin(req, res, () => {
    nextCalled = true;
  });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(nextCalled, false);
});

test('rejects wrong token', () => {
  const req = { headers: { authorization: 'Bearer definitely-not-the-token' } };
  const res = mockRes();
  let nextCalled = false;
  requireAdmin(req, res, () => {
    nextCalled = true;
  });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(nextCalled, false);
});

test('rejects same-length but wrong token', () => {
  const wrong = 'x'.repeat(config.admin.token.length);
  const req = { headers: { authorization: `Bearer ${wrong}` } };
  const res = mockRes();
  let nextCalled = false;
  requireAdmin(req, res, () => {
    nextCalled = true;
  });
  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(res.body, { error: 'unauthorized' });
  assert.strictEqual(nextCalled, false);
});

test('accepts correct token', () => {
  const req = { headers: { authorization: `Bearer ${config.admin.token}` } };
  const res = mockRes();
  let nextCalled = false;
  requireAdmin(req, res, () => {
    nextCalled = true;
  });
  assert.strictEqual(res.statusCode, null);
  assert.strictEqual(nextCalled, true);
});
