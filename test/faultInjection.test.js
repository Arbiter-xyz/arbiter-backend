import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFault, createFaultInjector, mountFaultRoutes } from '../src/faultInjection.js';

test('validateFault accepts valid http_error and latency faults with defaults', () => {
  const httpFault = validateFault({ type: 'http_error', pathPrefix: '/oracle' });
  assert.equal(httpFault.id, 'http_error:/oracle');
  assert.equal(httpFault.rate, 1);
  assert.equal(httpFault.status, 503);

  const latencyFault = validateFault({
    id: 'custom-lat',
    type: 'latency',
    pathPrefix: '/leaderboard',
    delayMs: 250,
    rate: 0.5,
  });
  assert.equal(latencyFault.id, 'custom-lat');
  assert.equal(latencyFault.delayMs, 250);
  assert.equal(latencyFault.rate, 0.5);
});

test('validateFault rejects invalid types, rates, statuses, delays, and protected pathPrefixes', () => {
  assert.throws(() => validateFault({ type: 'drop', pathPrefix: '/oracle' }), /type must be one of/);
  assert.throws(() => validateFault({ type: 'http_error', pathPrefix: 'oracle' }), /pathPrefix must be a path/);
  assert.throws(() => validateFault({ type: 'http_error', pathPrefix: '/%E0%A4%A' }), /valid URI path/);

  // Direct, case-variant, encoded, traversal, and ancestor prefixes of /admin or /metrics are blocked
  for (const blocked of [
    '/admin',
    '/admin/faults',
    '/ADMIN/faults',
    '/Admin',
    '/%61dmin',
    '//admin/faults',
    '/oracle/../admin',
    '/',
    '/a',
    '/adm',
    '/metrics',
    '/METRICS',
    '/%6detrics',
    '/m',
    '/met',
  ]) {
    assert.throws(
      () => validateFault({ type: 'http_error', pathPrefix: blocked }),
      /faults cannot target \/admin or \/metrics/,
      `expected pathPrefix "${blocked}" to be rejected`,
    );
  }

  for (const badRate of [-0.1, 1.1, NaN, Infinity, '0.5']) {
    assert.throws(
      () => validateFault({ type: 'http_error', pathPrefix: '/oracle', rate: badRate }),
      /rate must be between 0 and 1/,
    );
  }

  for (const badStatus of [200, 400, 499, 600, 503.5, '503']) {
    assert.throws(
      () => validateFault({ type: 'http_error', pathPrefix: '/oracle', status: badStatus }),
      /status must be a 5xx code/,
    );
  }

  for (const badDelay of [0, -5, 30_001, 10.5, undefined]) {
    assert.throws(
      () => validateFault({ type: 'latency', pathPrefix: '/oracle', delayMs: badDelay }),
      /delayMs must be an integer between 1 and 30000/,
    );
  }
});

test('createFaultInjector middleware injects errors/latency by rate and never intercepts /admin or /metrics', async () => {
  let rngValue = 0.2;
  const injector = createFaultInjector({ random: () => rngValue });

  injector.add({ id: 'err-oracle', type: 'http_error', pathPrefix: '/oracle', status: 502, rate: 0.5 });
  injector.add({ id: 'lat-oracle', type: 'latency', pathPrefix: '/oracle', delayMs: 5, rate: 0.5 });
  assert.equal(injector.list().length, 2);

  function runMiddleware(reqPath) {
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.body = payload;
          resolve({ intercepted: true, statusCode: this.statusCode, body: this.body });
        },
      };
      injector.middleware({ path: reqPath }, res, () => {
        resolve({ intercepted: false, statusCode: 200, body: null });
      });
    });
  }

  // rngValue (0.2) < rate (0.5): fault triggers
  const hit = await runMiddleware('/oracle/ask');
  assert.equal(hit.intercepted, true);
  assert.equal(hit.statusCode, 502);
  assert.deepEqual(hit.body, { error: 'injected fault', injected: true });

  // rngValue (0.8) >= rate (0.5): passes through
  rngValue = 0.8;
  const miss = await runMiddleware('/oracle/ask');
  assert.equal(miss.intercepted, false);

  // Non-matching path passes through even when rngValue = 0
  rngValue = 0;
  const other = await runMiddleware('/stats');
  assert.equal(other.intercepted, false);

  // Protected routes always pass through
  const adminReq = await runMiddleware('/Admin/faults');
  assert.equal(adminReq.intercepted, false);
  const metricsReq = await runMiddleware('/metrics');
  assert.equal(metricsReq.intercepted, false);

  assert.equal(injector.remove('err-oracle'), true);
  assert.equal(injector.remove('err-oracle'), false);
  injector.clear();
  assert.equal(injector.list().length, 0);
});

test('mountFaultRoutes wires GET, POST, and DELETE /admin/faults handlers', () => {
  const routes = new Map();
  const app = {
    get: (p, _auth, handler) => routes.set(`GET ${p}`, handler),
    post: (p, _auth, handler) => routes.set(`POST ${p}`, handler),
    delete: (p, _auth, handler) => routes.set(`DELETE ${p}`, handler),
  };
  const injector = createFaultInjector();
  const noopAuth = (_req, _res, next) => next();
  mountFaultRoutes(app, injector, noopAuth);

  const mockRes = () => ({
    code: 200,
    payload: null,
    ended: false,
    status(c) {
      this.code = c;
      return this;
    },
    json(p) {
      this.payload = p;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  });

  // POST valid fault -> 201
  const postOk = mockRes();
  routes.get('POST /admin/faults')({ body: { type: 'http_error', pathPrefix: '/oracle' } }, postOk);
  assert.equal(postOk.code, 201);
  assert.equal(postOk.payload.fault.id, 'http_error:/oracle');

  // POST invalid fault -> 400
  const postBad = mockRes();
  routes.get('POST /admin/faults')({ body: { type: 'http_error', pathPrefix: '/admin' } }, postBad);
  assert.equal(postBad.code, 400);
  assert.match(postBad.payload.error, /faults cannot target/);

  // GET /admin/faults -> lists registered fault
  const getRes = mockRes();
  routes.get('GET /admin/faults')({}, getRes);
  assert.equal(getRes.payload.faults.length, 1);

  // DELETE /admin/faults/:id -> 204 when present, 404 when missing
  const delOne = mockRes();
  routes.get('DELETE /admin/faults/:id')({ params: { id: 'http_error:/oracle' } }, delOne);
  assert.equal(delOne.code, 204);

  const delMissing = mockRes();
  routes.get('DELETE /admin/faults/:id')({ params: { id: 'http_error:/oracle' } }, delMissing);
  assert.equal(delMissing.code, 404);

  // DELETE /admin/faults -> 204 clears all
  injector.add({ type: 'latency', pathPrefix: '/jobs', delayMs: 10 });
  const delAll = mockRes();
  routes.get('DELETE /admin/faults')({}, delAll);
  assert.equal(delAll.code, 204);
  assert.equal(injector.list().length, 0);
});
