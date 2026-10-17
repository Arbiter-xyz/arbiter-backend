import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  jobsInflight,
  oldestInflightJobAge,
  httpRequestsTotal,
  httpRequestDuration,
  recordJobScan,
  metricsMiddleware,
  metricsHandler,
} from '../src/metrics.js';

async function getSeries(metric, labels) {
  const data = await metric.get();
  if (!labels) return data.values[0]?.value;
  return data.values.find((v) =>
    Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  )?.value;
}

test('recordJobScan resets stale status labels, counts non-settled jobs, and computes oldest in-flight age', async () => {
  const now = 1_700_000_100_000;
  recordJobScan(
    [
      { id: '1', status: 'collecting', createdAt: now - 30_000 },
      { id: '2', status: 'collecting', createdAt: now - 10_000 },
      { id: '3', status: 'disputed', updatedAt: now - 90_000 },
      { id: '4', status: 'settled', createdAt: now - 500_000 },
    ],
    now,
  );

  assert.equal(await getSeries(jobsInflight, { status: 'collecting' }), 2);
  assert.equal(await getSeries(jobsInflight, { status: 'disputed' }), 1);
  assert.equal(await getSeries(jobsInflight, { status: 'settled' }), undefined);
  assert.equal(await getSeries(oldestInflightJobAge), 90);

  // Subsequent scan with all jobs settled resets in-flight series and sets oldest age to 0
  recordJobScan([{ id: '1', status: 'settled', createdAt: now - 30_000 }], now);
  assert.equal(await getSeries(jobsInflight, { status: 'collecting' }), undefined);
  assert.equal(await getSeries(oldestInflightJobAge), 0);
});

test('metricsMiddleware bounds route label cardinality and skips latency histogram for SSE streaming routes', async () => {
  const runRequest = ({ method, baseUrl = '', routePath, statusCode = 200 }) => {
    const req = {
      method,
      baseUrl,
      route: routePath ? { path: routePath } : undefined,
    };
    const res = Object.assign(new EventEmitter(), { statusCode });
    let nextCalled = false;
    metricsMiddleware(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    res.emit('finish');
  };

  const beforeMatched = (await getSeries(httpRequestsTotal, {
    method: 'GET',
    route: '/oracle/:jobId',
    status: '200',
  })) || 0;
  runRequest({ method: 'GET', routePath: '/oracle/:jobId', statusCode: 200 });
  assert.equal(
    await getSeries(httpRequestsTotal, { method: 'GET', route: '/oracle/:jobId', status: '200' }),
    beforeMatched + 1,
  );

  // Unmatched routes collapse to 'unmatched' rather than exploding cardinality with raw URLs
  const beforeUnmatched = (await getSeries(httpRequestsTotal, {
    method: 'GET',
    route: 'unmatched',
    status: '404',
  })) || 0;
  runRequest({ method: 'GET', routePath: undefined, statusCode: 404 });
  assert.equal(
    await getSeries(httpRequestsTotal, { method: 'GET', route: 'unmatched', status: '404' }),
    beforeUnmatched + 1,
  );

  // Streaming SSE route (/workers/stream) increments counter but does NOT observe duration histogram
  runRequest({ method: 'GET', routePath: '/workers/stream', statusCode: 200 });
  const hist = await httpRequestDuration.get();
  const streamBuckets = hist.values.filter((v) => v.labels.route === '/workers/stream');
  assert.equal(streamBuckets.length, 0);
});

test('metricsHandler enforces optional Bearer token and serves Prometheus metrics when authorized', async () => {
  const guarded = metricsHandler({ token: 'secret-scrape-token' });

  const callHandler = async (handler, authHeader) => {
    let statusCode = 200;
    let body = null;
    const headers = {};
    const req = { get: (h) => (h.toLowerCase() === 'authorization' ? authHeader : '') };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      set(k, v) {
        headers[k.toLowerCase()] = v;
      },
      json(payload) {
        body = payload;
        return this;
      },
      send(payload) {
        body = payload;
        return this;
      },
    };
    await handler(req, res);
    return { statusCode, headers, body };
  };

  const unauth = await callHandler(guarded, 'Bearer wrong');
  assert.equal(unauth.statusCode, 401);

  const auth = await callHandler(guarded, 'Bearer secret-scrape-token');
  assert.equal(auth.statusCode, 200);
  assert.match(auth.body, /arbiter_build_info/);
});
