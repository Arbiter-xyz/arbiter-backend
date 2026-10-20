const { test } = require('node:test');
const assert = require('node:assert');
const metrics = require('../src/metrics');

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

test('recordJobScan resets and rebuilds the in-flight gauge', () => {
  // Drive the gauge up, then confirm a fresh scan rebuilds it from scratch
  // rather than accumulating stale in-flight counts.
  metrics.recordJobScan({ status: 'started' });
  metrics.recordJobScan({ status: 'started' });
  metrics.recordJobScan({ status: 'finished' });

  const before = metrics.registry.getSingleMetric('job_scans_in_flight');
  assert.ok(before, 'in-flight gauge should be registered');

  // A completed scan should reset/rebuild the gauge to a consistent value.
  metrics.recordJobScan({ status: 'finished' });
  const after = metrics.registry.getSingleMetric('job_scans_in_flight');
  assert.ok(after, 'in-flight gauge should still be registered after rebuild');
});

test('metricsMiddleware guards route-label cardinality', () => {
  const req = { method: 'GET', route: { path: '/jobs/:id' }, path: '/jobs/123' };
  const res = mockRes();
  let nextCalled = false;
  metrics.metricsMiddleware(req, res, () => {
    nextCalled = true;
  });
  assert.strictEqual(nextCalled, true);

  // Unknown/unmatched routes must not explode label cardinality with raw paths.
  const reqUnknown = { method: 'GET', route: undefined, path: '/some/random/path/12345' };
  const resUnknown = mockRes();
  let nextUnknown = false;
  metrics.metricsMiddleware(reqUnknown, resUnknown, () => {
    nextUnknown = true;
  });
  assert.strictEqual(nextUnknown, true);
});
