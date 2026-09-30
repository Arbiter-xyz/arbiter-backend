import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registry, metricsMiddleware, metricsHandler, recordJobScan } from '../src/metrics.js';
import { probeStore, probeChain, probeJobs } from '../src/healthProbes.js';
import { createFaultInjector, mountFaultRoutes, validateFault } from '../src/faultInjection.js';
import { evaluateSecurityPosture } from '../src/securityPosture.js';

async function value(name, labels = {}) {
  const metric = (await registry.getMetricsAsJSON()).find((m) => m.name === name);
  if (!metric) return undefined;
  const match = metric.values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val));
  return match?.value;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

const allowAdmin = (req, res, next) => (req.get('authorization') === 'Bearer admin' ? next() : res.status(401).end());

describe('HTTP metrics and fault injection through a real Express app', () => {
  let server;
  let base;
  const injector = createFaultInjector();

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(metricsMiddleware);
    app.use(injector.middleware);
    app.get('/metrics', metricsHandler({ token: 'scrape-secret' }));
    app.get('/oracle/:jobId', (req, res) => res.json({ ok: true }));
    mountFaultRoutes(app, injector, allowAdmin);
    ({ server, base } = await listen(app));
  });

  after(() => server.close());

  test('requests are counted by route pattern, not raw path', async () => {
    const before = (await value('arbiter_http_requests_total', { route: '/oracle/:jobId', status: '200' })) || 0;
    await fetch(`${base}/oracle/123`);
    await fetch(`${base}/oracle/456`);
    assert.equal(await value('arbiter_http_requests_total', { route: '/oracle/:jobId', status: '200' }), before + 2);
  });

  test('/metrics requires the scrape token when one is configured', async () => {
    assert.equal((await fetch(`${base}/metrics`)).status, 401);
    const res = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer scrape-secret' } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /arbiter_http_requests_total/);
  });

  test('an injected 5xx fault fails real requests and shows up as 5xx in the metrics', async () => {
    const add = await fetch(`${base}/admin/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer admin' },
      body: JSON.stringify({ type: 'http_error', pathPrefix: '/oracle', status: 503 }),
    });
    assert.equal(add.status, 201);

    const res = await fetch(`${base}/oracle/789`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).injected, true);
    // The fault fired before any route matched, so it lands under 'unmatched'.
    assert.ok((await value('arbiter_http_requests_total', { route: 'unmatched', status: '503' })) >= 1);

    await fetch(`${base}/admin/faults`, { method: 'DELETE', headers: { authorization: 'Bearer admin' } });
    assert.equal((await fetch(`${base}/oracle/789`)).status, 200);
  });

  test('an injected latency fault delays requests', async () => {
    injector.add({ type: 'latency', pathPrefix: '/oracle', delayMs: 300 });
    const start = Date.now();
    await fetch(`${base}/oracle/1`);
    assert.ok(Date.now() - start >= 280);
    injector.clear();
  });

  test('fault routes are admin-gated', async () => {
    assert.equal((await fetch(`${base}/admin/faults`)).status, 401);
  });
});

describe('validateFault', () => {
  test('refuses faults that could blind the drill or lock it out', () => {
    assert.throws(() => validateFault({ type: 'http_error', pathPrefix: '/admin/faults' }));
    assert.throws(() => validateFault({ type: 'http_error', pathPrefix: '/metrics' }));
  });

  test('rejects non-5xx statuses and unbounded delays', () => {
    assert.throws(() => validateFault({ type: 'http_error', pathPrefix: '/x', status: 404 }));
    assert.throws(() => validateFault({ type: 'latency', pathPrefix: '/x', delayMs: 10 * 60_000 }));
    assert.throws(() => validateFault({ type: 'disk_full', pathPrefix: '/x' }));
  });
});

describe('fault injection is refused in production', () => {
  test('ARBITER_FAULT_INJECTION=true is fatal in a production-looking deployment', () => {
    const { findings } = evaluateSecurityPosture({
      NODE_ENV: 'production',
      SESSION_SECRET: 'x'.repeat(64),
      ALLOWED_ORIGINS: 'https://app.example.com',
      ARBITER_FAULT_INJECTION: 'true',
    });
    assert.deepEqual(
      findings.filter((f) => f.severity === 'fatal').map((f) => f.setting),
      ['ARBITER_FAULT_INJECTION'],
    );
  });

  test('and silent in local dev', () => {
    assert.deepEqual(evaluateSecurityPosture({ ARBITER_FAULT_INJECTION: 'true' }).findings, []);
  });
});

describe('health probes', () => {
  test('in-memory store: up but not durable', async () => {
    await probeStore({ getClient: () => null });
    assert.equal(await value('arbiter_store_up'), 1);
    assert.equal(await value('arbiter_store_durable'), 0);
  });

  test('Redis that stops answering PING: down', async () => {
    await probeStore({ getClient: () => ({ ping: () => new Promise(() => {}) }) }, { timeoutMs: 50 });
    assert.equal(await value('arbiter_store_up'), 0);
    assert.equal(await value('arbiter_store_durable'), 1);

    await probeStore({ getClient: () => ({ ping: async () => 'PONG' }) });
    assert.equal(await value('arbiter_store_up'), 1);
  });

  test('chain RPC probe tracks liveness and the latest ledger', async () => {
    await probeChain(async () => 4_870_740);
    assert.equal(await value('arbiter_chain_rpc_up'), 1);
    assert.equal(await value('arbiter_chain_latest_ledger'), 4_870_740);

    await probeChain(async () => {
      throw new Error('503 Service Unavailable');
    });
    assert.equal(await value('arbiter_chain_rpc_up'), 0);
    // The last good ledger is kept, not zeroed, so the stall alert stays meaningful.
    assert.equal(await value('arbiter_chain_latest_ledger'), 4_870_740);
  });

  test('job scan reports in-flight counts and the oldest in-flight age', async () => {
    const now = 1_800_000_000_000;
    const jobs = {
      a: { status: 'awaiting_workers', createdAt: now - 20 * 60_000 },
      b: { status: 'holding', createdAt: now - 5_000 },
      c: { status: 'settled', createdAt: now - 99 * 60_000 },
    };
    await probeJobs({ getKnownJobIds: async () => Object.keys(jobs), getJob: async (id) => jobs[id] }, now);
    assert.equal(await value('arbiter_jobs_inflight', { status: 'awaiting_workers' }), 1);
    assert.equal(await value('arbiter_jobs_inflight', { status: 'holding' }), 1);
    assert.equal(await value('arbiter_jobs_inflight', { status: 'settled' }), undefined);
    assert.equal(await value('arbiter_job_oldest_inflight_age_seconds'), 20 * 60);

    recordJobScan([], now);
    assert.equal(await value('arbiter_job_oldest_inflight_age_seconds'), 0);
  });
});
