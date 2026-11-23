import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adminRole,
  requireAdminRole,
  requireAdminResolver,
  requireRole,
  resolveAdminRole,
} from '../src/adminAuth.js';

const FULL = 'full';
const READONLY = 'readonly';

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
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

function makeReq(token) {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

function runMiddleware(mw, req) {
  const res = makeRes();
  let nextCalled = false;
  mw(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

const TOKENS = {
  ADMIN_TOKEN: 'full-token',
  ADMIN_READONLY_TOKEN: 'readonly-token',
};

test('requireAdminRole returns 503 when no admin tokens configured', () => {
  withEnv({ ADMIN_TOKEN: undefined, ADMIN_READONLY_TOKEN: undefined }, () => {
    const { res, nextCalled } = runMiddleware(requireAdminRole(), makeReq('anything'));
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 503);
  });
});

test('requireAdminRole returns 401 for missing or wrong token', () => {
  withEnv(TOKENS, () => {
    const missing = runMiddleware(requireAdminRole(), makeReq(undefined));
    assert.equal(missing.nextCalled, false);
    assert.equal(missing.res.statusCode, 401);

    const wrong = runMiddleware(requireAdminRole(), makeReq('nope'));
    assert.equal(wrong.nextCalled, false);
    assert.equal(wrong.res.statusCode, 401);
  });
});

test('requireAdminRole returns 403 when role is insufficient', () => {
  withEnv(TOKENS, () => {
    const { res, nextCalled } = runMiddleware(requireAdminRole(FULL), makeReq('readonly-token'));
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });
});

test('requireAdminRole calls next for sufficient role', () => {
  withEnv(TOKENS, () => {
    const full = runMiddleware(requireAdminRole(FULL), makeReq('full-token'));
    assert.equal(full.nextCalled, true);

    const readonly = runMiddleware(requireAdminRole(READONLY), makeReq('readonly-token'));
    assert.equal(readonly.nextCalled, true);
  });
});

test('resolveAdminRole returns role for known token and null otherwise', () => {
  withEnv(TOKENS, () => {
    assert.equal(resolveAdminRole('full-token'), FULL);
    assert.equal(resolveAdminRole('readonly-token'), READONLY);
    assert.equal(resolveAdminRole('unknown'), null);
    assert.equal(resolveAdminRole(undefined), null);
  });
});

test('requireAdminResolver throws UNAUTHENTICATED/401 for missing or wrong token', () => {
  withEnv(TOKENS, () => {
    for (const token of [undefined, 'nope']) {
      assert.throws(
        () => requireAdminResolver({ req: makeReq(token) }),
        (err) => {
          assert.equal(err.extensions.code, 'UNAUTHENTICATED');
          assert.equal(err.extensions.http.status, 401);
          return true;
        },
      );
    }
  });
});

test('requireAdminResolver throws FORBIDDEN/403 with requiredRole when insufficient', () => {
  withEnv(TOKENS, () => {
    assert.throws(
      () => requireAdminResolver({ req: makeReq('readonly-token') }, FULL),
      (err) => {
        assert.equal(err.extensions.code, 'FORBIDDEN');
        assert.equal(err.extensions.http.status, 403);
        assert.equal(err.extensions.requiredRole, FULL);
        return true;
      },
    );
  });
});

test('requireAdminResolver returns credential for sufficient role', () => {
  withEnv(TOKENS, () => {
    const cred = requireAdminResolver({ req: makeReq('full-token') }, FULL);
    assert.equal(cred.role, FULL);

    const readonly = requireAdminResolver({ req: makeReq('readonly-token') }, READONLY);
    assert.equal(readonly.role, READONLY);
  });
});

test('adminRole defaults to reviewer and returns null for unknown roles', () => {
  assert.equal(adminRole(undefined), 'reviewer');
  assert.equal(adminRole(''), 'reviewer');
  assert.equal(adminRole('reviewer'), 'reviewer');
  assert.equal(adminRole('full'), FULL);
  assert.equal(adminRole('readonly'), READONLY);
  assert.equal(adminRole('bogus'), null);
});

test('requireRole enforces the required role', () => {
  withEnv(TOKENS, () => {
    const ok = runMiddleware(requireRole(FULL), makeReq('full-token'));
    assert.equal(ok.nextCalled, true);

    const forbidden = runMiddleware(requireRole(FULL), makeReq('readonly-token'));
    assert.equal(forbidden.nextCalled, false);
    assert.equal(forbidden.res.statusCode, 403);
  });
});
