import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ArbiterClient } from '../src/client.js';
import { createServer, fromEnv, summarizeJob } from '../src/server.js';

/** Mocked HTTP layer: records every request, replies from a route table. */
function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}${u.search}`;
    calls.push({ key, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const handler = routes[key];
    if (!handler) throw new Error(`unmocked request: ${key}`);
    const { status, json } = typeof handler === 'function' ? handler(calls.filter((c) => c.key === key).length) : handler;
    return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(json) };
  };
  return { fetchImpl, calls };
}

async function connect({ routes, apiKey = 'ak_live_test', config = {} }) {
  const { fetchImpl, calls } = mockFetch(routes);
  const client = new ArbiterClient({ baseUrl: 'http://arbiter.test/', apiKey, fetchImpl, sleep: async () => {} });
  const server = createServer({ client, config });
  const mcp = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), mcp.connect(b)]);
  const call = async (name, args) => {
    const res = await mcp.callTool({ name, arguments: args });
    return { ...res, data: res.isError ? res.content[0].text : JSON.parse(res.content[0].text) };
  };
  return { call, calls, mcp };
}

const settled = { jobId: 'q1', status: 'settled', outcome: 'resolved', answer: 'Paris', confidence: 1, totalAnswers: 3, reconciliationMethod: 'exact-match-fastpath' };

test('lists the four tools', async () => {
  const { mcp } = await connect({ routes: {} });
  const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['arbiter_ask', 'arbiter_get_job', 'arbiter_leaderboard', 'arbiter_stats']);
});

test('arbiter_ask (API key) maps to POST /oracle with a Bearer header, then polls GET /oracle/:jobId to the answer', async () => {
  const { call, calls } = await connect({
    routes: {
      'POST /oracle': { status: 202, json: { jobId: 'q1', tier: 'standard' } },
      'GET /oracle/q1': (n) => (n < 3 ? { status: 202, json: { status: 'awaiting_workers' } } : { status: 200, json: settled }),
    },
  });
  const res = await call('arbiter_ask', { question: 'Capital of France?', tier: 'standard', category: 'geo' });

  assert.equal(res.data.answer, 'Paris');
  assert.equal(res.data.outcome, 'resolved');
  const post = calls[0];
  assert.equal(post.key, 'POST /oracle');
  assert.equal(post.headers.Authorization, 'Bearer ak_live_test');
  assert.deepEqual(post.body, { question: 'Capital of France?', tier: 'standard', category: 'geo' });
  assert.equal(calls.filter((c) => c.key === 'GET /oracle/q1').length, 3);
});

test('arbiter_ask in sandbox mode maps to POST /oracle/sandbox with no auth header and tags the result', async () => {
  const { call, calls } = await connect({
    apiKey: '',
    config: { sandbox: true },
    routes: {
      'POST /oracle/sandbox': { status: 202, json: { jobId: 'q2' } },
      'GET /oracle/q2': { status: 200, json: { ...settled, jobId: 'q2', sandbox: true } },
    },
  });
  const res = await call('arbiter_ask', { question: 'hi' });
  assert.equal(calls[0].key, 'POST /oracle/sandbox');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.match(res.data.warning, /SANDBOX/);
});

test('arbiter_ask with wait=false returns the jobId without polling', async () => {
  const { call, calls } = await connect({ routes: { 'POST /oracle': { status: 202, json: { jobId: 'q3', tier: 'auto' } } } });
  const res = await call('arbiter_ask', { question: 'q', tier: 'auto', wait: false });
  assert.equal(res.data.jobId, 'q3');
  assert.equal(res.data.status, 'submitted');
  assert.equal(calls.length, 1);
});

test('arbiter_ask with neither an API key nor sandbox mode fails clearly and makes no HTTP call', async () => {
  const { call, calls } = await connect({ apiKey: '', routes: {} });
  const res = await call('arbiter_ask', { question: 'q' });
  assert.equal(res.isError, true);
  assert.match(res.data, /ARBITER_API_KEY/);
  assert.equal(calls.length, 0);
});

test('a 402 payment challenge (no wallet) and an out-of-credit 402 are both surfaced as tool errors', async () => {
  const challenge = await connect({ routes: { 'POST /oracle': { status: 402, json: { questionId: '9', amount: '0.25' } } } });
  const r1 = await challenge.call('arbiter_ask', { question: 'q' });
  assert.equal(r1.isError, true);
  assert.match(r1.data, /Stellar wallet/);

  const broke = await connect({ routes: { 'POST /oracle': { status: 402, json: { error: 'insufficient credit balance — top up via POST /billing/checkout' } } } });
  const r2 = await broke.call('arbiter_ask', { question: 'q' });
  assert.match(r2.data, /insufficient credit/);
});

test('arbiter_get_job maps to GET /oracle/:jobId and the poll loop is bounded by timeoutSeconds', async () => {
  const { call, calls } = await connect({
    config: { pollIntervalMs: 1000 },
    routes: { 'GET /oracle/slow': { status: 202, json: { status: 'awaiting_workers' } } },
  });
  const res = await call('arbiter_get_job', { jobId: 'slow', timeoutSeconds: 3 });
  assert.equal(res.data.status, 'awaiting_workers');
  assert.match(res.data.note, /again/);
  // 1 initial + 3 one-second polls == the 3s budget, then it gives up rather than looping forever.
  assert.equal(calls.length, 4);
});

test('arbiter_get_job wait=false is a single request; unknown job is a tool error', async () => {
  const one = await connect({ routes: { 'GET /oracle/q1': { status: 202, json: { status: 'reconciling' } } } });
  await one.call('arbiter_get_job', { jobId: 'q1', wait: false });
  assert.equal(one.calls.length, 1);

  const missing = await connect({ routes: { 'GET /oracle/nope': { status: 404, json: { error: 'unknown or expired jobId' } } } });
  const res = await missing.call('arbiter_get_job', { jobId: 'nope' });
  assert.equal(res.isError, true);
  assert.match(res.data, /unknown or expired/);
});

test('refunded jobs report the reason instead of an answer', () => {
  const s = summarizeJob({ jobId: 'q', status: 'settled', outcome: 'refunded', reason: 'no workers answered in time' });
  assert.equal(s.answer, undefined);
  assert.equal(s.reason, 'no workers answered in time');
});

test('arbiter_leaderboard maps to GET /leaderboard?limit=, arbiter_stats to GET /stats', async () => {
  const { call, calls } = await connect({
    routes: {
      'GET /leaderboard?limit=5': { status: 200, json: { leaderboard: [{ workerId: 'GABC', matchRatio: 0.97 }] } },
      'GET /stats': { status: 200, json: { onlineWorkers: 4, resolved: 10, refunded: 1 } },
    },
  });
  assert.equal((await call('arbiter_leaderboard', { limit: 5 })).data.leaderboard[0].workerId, 'GABC');
  assert.equal((await call('arbiter_stats', {})).data.onlineWorkers, 4);
  assert.deepEqual(calls.map((c) => c.key), ['GET /leaderboard?limit=5', 'GET /stats']);
  assert.equal(calls[1].headers.Authorization, undefined, 'read-only tools send no credentials');
});

test('an unreachable backend is a tool error, not a crash', async () => {
  const client = new ArbiterClient({ baseUrl: 'http://x', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const server = createServer({ client, config: { sandbox: true } });
  const mcp = new Client({ name: 't', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), mcp.connect(b)]);
  const res = await mcp.callTool({ name: 'arbiter_stats', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /could not reach Arbiter/);
});

test('fromEnv reads ARBITER_BASE_URL / ARBITER_API_KEY / ARBITER_SANDBOX and applies defaults', () => {
  const a = fromEnv({ ARBITER_BASE_URL: 'https://api.example.com/', ARBITER_API_KEY: 'ak_live_x', ARBITER_SANDBOX: 'true', ARBITER_MAX_WAIT_MS: '5000' });
  assert.equal(a.client.baseUrl, 'https://api.example.com');
  assert.equal(a.client.apiKey, 'ak_live_x');
  assert.equal(a.config.sandbox, true);
  assert.equal(a.config.maxWaitMs, 5000);
  const b = fromEnv({});
  assert.equal(b.client.baseUrl, 'http://localhost:4000');
  assert.equal(b.config.sandbox, false);
  assert.equal(b.config.pollIntervalMs, 2000);
});
