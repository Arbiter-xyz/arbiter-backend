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

test('createInvoiceBilledAccount provisions account and credits invoice amount', async () => {
  const billing = require('../src/billing');
  const handler = billing.createInvoiceBilledAccount;
  assert.strictEqual(typeof handler, 'function');

  const creditCalls = [];
  const originalCredit = billing.credit;
  billing.credit = (accountId, amount, meta) => {
    creditCalls.push({ accountId, amount, meta });
    return { accountId, amount };
  };

  try {
    const req = {
      body: {
        email: 'invoice@example.com',
        name: 'Invoice Co',
        invoiceAmount: 2500,
      },
    };
    const res = mockRes();
    let nextErr = null;
    let nextCalled = false;
    await handler(req, res, (err) => {
      nextCalled = true;
      nextErr = err || null;
    });

    assert.strictEqual(nextErr, null);
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(creditCalls.length, 1);
    assert.strictEqual(creditCalls[0].amount, 2500);
    assert.ok(creditCalls[0].accountId, 'credit() should receive a provisioned account id');
  } finally {
    billing.credit = originalCredit;
  }
});
