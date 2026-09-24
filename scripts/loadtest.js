#!/usr/bin/env node
/**
 * Step-ramp load test for a running arbiter-backend. No dependencies beyond
 * Node 22. See docs/capacity/README.md for how to run it against a real
 * deployment and how to read the results.
 *
 *   node scripts/loadtest.js --target <url> --scenario <name> [options]
 *
 * Scenarios (each isolates one component):
 *   read       GET /health, /stats, /leaderboard: raw HTTP + store-read ceiling
 *   challenge  POST /oracle step 1 (402 quote): store writes + pricing, no chain
 *   sandbox    POST /oracle/sandbox, then poll GET /oracle/:jobId until settled:
 *              the full async job lifecycle (claim, job writes, polling), no chain
 *   sse        hold N open worker SSE streams (GET /app/events) and probe
 *              /health latency under that load: the dispatch channel's ceiling
 *
 * Load model: closed loop. Each stage runs `c` virtual users back to back for
 * --stage-seconds; for `sse`, each stage's number is the count of open streams.
 * A stage "breaks" when its error rate exceeds --max-error-rate or its p95
 * exceeds --max-p95-ms (for `sandbox`, also when job p95 exceeds
 * --max-job-p95-ms); the run stops at the first broken stage. 429s are
 * counted separately: they mean the target's per-IP rate limiter was hit, which
 * is a configured ceiling, not a capacity limit (raise *_RATE_LIMIT_MAX on
 * the target for a capacity run, and say so in the report).
 *
 * Safety: a non-loopback --target also needs --i-operate-this-target. Ramping
 * load until something breaks is only OK against a deployment you run.
 */
import http from 'node:http';
import https from 'node:https';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const USAGE = `usage: node scripts/loadtest.js --target <url> --scenario read|challenge|sandbox|sse
  [--stages 5,10,25,50,100] [--stage-seconds 20] [--max-error-rate 0.05]
  [--max-p95-ms 2000] [--max-job-p95-ms 5000] [--out results.json] [--i-operate-this-target]`;

const { values: opts } = parseArgs({
  options: {
    target: { type: 'string' },
    scenario: { type: 'string' },
    stages: { type: 'string', default: '5,10,25,50,100' },
    'stage-seconds': { type: 'string', default: '20' },
    'max-error-rate': { type: 'string', default: '0.05' },
    'max-p95-ms': { type: 'string', default: '2000' },
    'max-job-p95-ms': { type: 'string', default: '5000' },
    out: { type: 'string' },
    'i-operate-this-target': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

function die(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!opts.target || !opts.scenario) die('--target and --scenario are required');
const target = new URL(opts.target);
const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(target.hostname);
if (!loopback && !opts['i-operate-this-target']) {
  die(`refusing to load-test ${target.origin} without --i-operate-this-target (only ramp load against a deployment you run)`);
}
const stages = opts.stages.split(',').map(Number).filter((n) => n > 0);
const stageMs = Number(opts['stage-seconds']) * 1000;
const maxErrorRate = Number(opts['max-error-rate']);
const maxP95Ms = Number(opts['max-p95-ms']);
// sandbox only: a job's submit-to-settled time, which includes the sandbox's
// own simulated reconciliation delay (~0.8s), so it gets its own threshold.
const maxJobP95Ms = Number(opts['max-job-p95-ms']);
const base = target.origin + target.pathname.replace(/\/$/, '');

// ---------------------------------------------------------------------------
// Measurement

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

class Recorder {
  constructor() {
    this.latencies = [];
    this.statuses = {};
    this.errors = 0; // network errors + 5xx + unexpected statuses
    this.rateLimited = 0;
    this.extra = [];
  }

  record(ms, status, expected) {
    this.latencies.push(ms);
    this.statuses[status] = (this.statuses[status] || 0) + 1;
    if (status === 429) this.rateLimited += 1;
    else if (!expected.includes(status)) this.errors += 1;
  }

  summarize(durationMs) {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const total = sorted.length;
    const round = (v) => (v === null ? null : Math.round(v));
    return {
      requests: total,
      rps: Number((total / (durationMs / 1000)).toFixed(1)),
      p50: round(percentile(sorted, 50)),
      p95: round(percentile(sorted, 95)),
      p99: round(percentile(sorted, 99)),
      max: round(sorted[total - 1] ?? null),
      errorRate: total ? Number((this.errors / total).toFixed(4)) : 0,
      rateLimited: this.rateLimited,
      statuses: this.statuses,
    };
  }
}

async function timed(recorder, url, init, expected) {
  const start = performance.now();
  try {
    const res = await fetch(url, init);
    const body = await res.text();
    recorder.record(performance.now() - start, res.status, expected);
    return { status: res.status, body };
  } catch {
    recorder.record(performance.now() - start, 'network-error', expected);
    return { status: 0, body: '' };
  }
}

const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Scenarios: each returns one virtual user's single iteration.

const READ_PATHS = ['/health', '/stats', '/leaderboard?limit=20'];
let seq = 0;

const scenarios = {
  read: (rec) => timed(rec, base + READ_PATHS[seq++ % READ_PATHS.length], undefined, [200]),

  challenge: (rec) =>
    timed(rec, `${base}/oracle`, json({ question: `load test question ${seq++}?`, tier: 'standard' }), [402]),

  // One iteration = one whole sandbox job, submit to settled. The recorder
  // gets every HTTP call; job end-to-end latency goes into rec.extra.
  sandbox: async (rec) => {
    const start = performance.now();
    const created = await timed(rec, `${base}/oracle/sandbox`, json({ question: `load test ${seq++}?` }), [202]);
    if (created.status !== 202) return;
    const { jobId } = JSON.parse(created.body);
    for (let i = 0; i < 120; i++) {
      await sleep(250);
      const polled = await timed(rec, `${base}/oracle/${jobId}`, undefined, [200, 202]);
      if (polled.status === 200) {
        rec.extra.push(performance.now() - start);
        return;
      }
      if (polled.status !== 202) return;
    }
  },
};

async function runClosedLoopStage(scenario, concurrency) {
  const rec = new Recorder();
  const deadline = Date.now() + stageMs;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (Date.now() < deadline) await scenario(rec);
    }),
  );
  const summary = rec.summarize(performance.now() - start);
  if (rec.extra.length) {
    const jobs = [...rec.extra].sort((a, b) => a - b);
    summary.jobs = { completed: jobs.length, perSecond: Number((jobs.length / (stageMs / 1000)).toFixed(1)), p50: Math.round(percentile(jobs, 50)), p95: Math.round(percentile(jobs, 95)) };
  }
  return summary;
}

// ---------------------------------------------------------------------------
// SSE: raw node:http, one socket per stream (agent: false), so held-open
// streams can never starve the /health probe of pooled connections (the
// same pool-starvation bug demo-agent/worker-sim.js documents).

const openStreams = [];
// Monotonic, so worker ids never repeat: the server keys its registry by
// workerId, and a reused id would silently replace an open stream.
let nextStreamId = 0;

function openStream(index) {
  const url = new URL(`${base}/app/events?worker=${encodeURIComponent(`loadtest-worker-${index}`)}`);
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const start = performance.now();
    const req = lib.get(url, { agent: false }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve({ ok: false, status: res.statusCode, ms: performance.now() - start });
        return;
      }
      res.once('data', () => {
        // Connected: drop the connect timeout. Left armed, it would destroy
        // an idle stream just as the server's 15s keep-alive is due.
        req.setTimeout(0);
        resolve({ ok: true, status: 200, ms: performance.now() - start });
      });
      openStreams.push(req);
    });
    req.on('error', () => resolve({ ok: false, status: 'network-error', ms: performance.now() - start }));
    req.setTimeout(15_000, () => {
      req.destroy();
      resolve({ ok: false, status: 'timeout', ms: performance.now() - start });
    });
  });
}

async function runSseStage(targetOpen) {
  const connect = new Recorder();
  const toOpen = targetOpen - openStreams.length;
  // Open in batches of 50 so the connect burst itself isn't the test.
  for (let i = 0; i < toOpen; i += 50) {
    const batch = await Promise.all(Array.from({ length: Math.min(50, toOpen - i) }, () => openStream(nextStreamId++)));
    for (const r of batch) connect.record(r.ms, r.status, [200]);
  }
  const probe = new Recorder();
  const deadline = Date.now() + stageMs;
  const start = performance.now();
  while (Date.now() < deadline) {
    await timed(probe, `${base}/health`, undefined, [200]);
    await sleep(100);
  }
  const health = await fetch(`${base}/health`).then((r) => r.json()).catch(() => ({}));
  const probeSummary = probe.summarize(performance.now() - start);
  const connectSummary = connect.summarize(1000);
  return {
    openStreams: openStreams.length,
    serverReportedOnlineWorkers: health.onlineWorkers ?? null,
    connect: { attempted: toOpen, ...connectSummary, rps: undefined },
    // The stage's verdict is judged on the probe plus connect failures.
    ...probeSummary,
    errorRate: Number(((probe.errors + connect.errors) / Math.max(1, probe.latencies.length + connect.latencies.length)).toFixed(4)),
    rateLimited: probe.rateLimited + connect.rateLimited,
  };
}

// ---------------------------------------------------------------------------

function verdict(s) {
  if (s.rateLimited > 0) return 'RATE-LIMITED';
  if (s.errorRate > maxErrorRate) return 'BROKEN (errors)';
  if (s.p95 !== null && s.p95 > maxP95Ms) return 'BROKEN (p95)';
  if (s.jobs && s.jobs.p95 > maxJobP95Ms) return 'BROKEN (job p95)';
  return 'ok';
}

async function main() {
  if (!scenarios[opts.scenario] && opts.scenario !== 'sse') die(`unknown scenario "${opts.scenario}"`);
  console.log(`target ${base} · scenario ${opts.scenario} · stages ${stages.join(',')} · ${stageMs / 1000}s each`);
  console.log(`break when error rate > ${maxErrorRate} or p95 > ${maxP95Ms}ms\n`);

  const results = [];
  for (const level of stages) {
    const summary = opts.scenario === 'sse' ? await runSseStage(level) : await runClosedLoopStage(scenarios[opts.scenario], level);
    const v = verdict(summary);
    results.push({ level, verdict: v, ...summary });
    const jobs = summary.jobs ? ` · jobs/s ${summary.jobs.perSecond} (job p95 ${summary.jobs.p95}ms)` : '';
    const sse = opts.scenario === 'sse' ? ` · open ${summary.openStreams} (server sees ${summary.serverReportedOnlineWorkers}) · connect p95 ${summary.connect.p95}ms` : '';
    console.log(
      `${opts.scenario === 'sse' ? 'streams' : 'vus'} ${String(level).padStart(5)} │ ${String(summary.rps).padStart(7)} req/s │ ` +
        `p50 ${summary.p50}ms p95 ${summary.p95}ms p99 ${summary.p99}ms │ err ${(summary.errorRate * 100).toFixed(2)}% │ 429 ${summary.rateLimited}${jobs}${sse} │ ${v}`,
    );
    if (v !== 'ok') break;
  }

  for (const req of openStreams) req.destroy();
  const report = { target: base, scenario: opts.scenario, stageSeconds: stageMs / 1000, maxErrorRate, maxP95Ms, maxJobP95Ms, finishedAt: new Date().toISOString(), results };
  if (opts.out) await writeFile(opts.out, `${JSON.stringify(report, null, 2)}\n`);

  const lastOk = [...results].reverse().find((r) => r.verdict === 'ok');
  const broke = results.find((r) => r.verdict !== 'ok');
  console.log(
    `\nhighest passing stage: ${lastOk ? `${lastOk.level} (${lastOk.rps} req/s)` : 'none'}` +
      (broke ? ` · stopped at ${broke.level}: ${broke.verdict}` : ' · never broke: raise --stages to find the ceiling'),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
