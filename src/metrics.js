import client from 'prom-client';

/**
 * Prometheus metrics for the backend (scraped at GET /metrics, alerted on by
 * ops/observability/prometheus/alerts.yml).
 *
 * Deliberately a leaf module: it imports nothing from the rest of src/, so
 * any module can record into it without creating an import cycle, and the
 * tests can exercise it without a store, a chain, or a booted server. The
 * probes that feed the gauges below (store/chain/job scans) live in
 * healthProbes.js and are started from server.js.
 *
 * Every alert in alerts.yml is written against a metric defined here — if you
 * rename one, `promtool test rules` in CI (ops/observability/prometheus/
 * alerts.test.yml) is what catches the rule silently going dead.
 */

export const registry = new client.Registry();
registry.setDefaultLabels({ service: 'arbiter-backend' });
client.collectDefaultMetrics({ register: registry, prefix: 'arbiter_' });

const ms = (v) => v / 1000;

export const httpRequestsTotal = new client.Counter({
  name: 'arbiter_http_requests_total',
  help: 'HTTP requests handled, by method, matched route and status code.',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

export const httpRequestDuration = new client.Histogram({
  name: 'arbiter_http_request_duration_seconds',
  help: 'HTTP request latency, by method and matched route.',
  labelNames: ['method', 'route'],
  // SSE streams (/workers/stream etc.) stay open for minutes and would land
  // in +Inf; they're excluded in the middleware, not bucketed here.
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const storeUp = new client.Gauge({
  name: 'arbiter_store_up',
  help: '1 if the last store probe (Redis PING, or the in-memory store) succeeded, else 0.',
  registers: [registry],
});

export const storeDurable = new client.Gauge({
  name: 'arbiter_store_durable',
  help: '1 if state lives in Redis, 0 if the process fell back to the in-memory store (state lost on restart).',
  registers: [registry],
});

export const chainRpcUp = new client.Gauge({
  name: 'arbiter_chain_rpc_up',
  help: '1 if the last Soroban RPC probe (getLatestLedger) succeeded, else 0.',
  registers: [registry],
});

export const chainLatestLedger = new client.Gauge({
  name: 'arbiter_chain_latest_ledger',
  help: 'Latest ledger sequence reported by the Soroban RPC at the last successful probe.',
  registers: [registry],
});

export const chainRpcProbeSeconds = new client.Gauge({
  name: 'arbiter_chain_rpc_probe_seconds',
  help: 'Duration of the last Soroban RPC probe.',
  registers: [registry],
});

export const onlineWorkers = new client.Gauge({
  name: 'arbiter_online_workers',
  help: 'Workers currently connected over SSE to this instance.',
  registers: [registry],
});

export const jobsInflight = new client.Gauge({
  name: 'arbiter_jobs_inflight',
  help: 'Non-settled paid jobs in the job index, by status.',
  labelNames: ['status'],
  registers: [registry],
});

export const oldestInflightJobAge = new client.Gauge({
  name: 'arbiter_job_oldest_inflight_age_seconds',
  help: 'Age of the oldest non-settled paid job (0 when there are none).',
  registers: [registry],
});

export const settlementsTotal = new client.Counter({
  name: 'arbiter_settlements_total',
  help: 'Jobs that transitioned to settled, by outcome (resolved, refunded, refund_pending_timeout, ...).',
  labelNames: ['outcome'],
  registers: [registry],
});

export const adminInvocationsTotal = new client.Counter({
  name: 'arbiter_admin_invocations_total',
  help: 'Contract calls signed with the platform admin key (resolve/refund/charge/touch), by method and result.',
  labelNames: ['method', 'result'],
  registers: [registry],
});

export const probeErrorsTotal = new client.Counter({
  name: 'arbiter_probe_errors_total',
  help: 'Health-probe failures, by probe.',
  labelNames: ['probe'],
  registers: [registry],
});

// --- Disaster recovery (disasterRecovery.js) -------------------------------

export const onchainPendingQuestions = new client.Gauge({
  name: 'arbiter_onchain_pending_questions',
  help: "Questions Pending in the contract's on-chain index at the last recovery sweep.",
  registers: [registry],
});

export const recoveryActionable = new client.Gauge({
  name: 'arbiter_recovery_actionable_pending_questions',
  help:
    'On-chain Pending questions that no local state can still settle, left over after the last recovery sweep, ' +
    'by reason (orphaned, stale_inflight, failed_settlement, inconsistent).',
  labelNames: ['reason'],
  registers: [registry],
});

export const recoveryRefundsTotal = new client.Counter({
  name: 'arbiter_recovery_refunds_total',
  help: 'refund() calls made by the recovery sweep, by reason and result (ok, error, already_settled).',
  labelNames: ['reason', 'result'],
  registers: [registry],
});

export const recoverySweepLastSuccess = new client.Gauge({
  name: 'arbiter_recovery_sweep_last_success_timestamp_seconds',
  help: 'Unix time of the last recovery sweep that completed its chain scan.',
  registers: [registry],
});

export const recoverySweepFailuresTotal = new client.Counter({
  name: 'arbiter_recovery_sweep_failures_total',
  help: 'Recovery sweeps that could not complete their chain scan.',
  registers: [registry],
});

export const buildInfo = new client.Gauge({
  name: 'arbiter_build_info',
  help: 'Always 1; labels carry the running version and network.',
  labelNames: ['version', 'network'],
  registers: [registry],
});

// Label values a recovery sweep can emit — initialised to 0 up front so an
// alert on "> 0" has a series to evaluate from the first scrape instead of
// relying on absent() gymnastics.
export const RECOVERY_REASONS = ['orphaned', 'stale_inflight', 'failed_settlement', 'inconsistent'];
for (const reason of RECOVERY_REASONS) recoveryActionable.set({ reason }, 0);

/** Routes that hold a connection open indefinitely (SSE). Their "latency"
 * is the session length, which would swamp the latency histogram. */
const STREAMING_ROUTE = /\/stream$|\/events$/;

/** Express middleware recording one counter increment and one latency
 * observation per request. Uses the matched route pattern (e.g.
 * `/oracle/:jobId`), never the raw path, so label cardinality stays bounded
 * no matter what ids clients send; anything that matched no route is
 * `unmatched`. */
export function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const route = req.route ? `${req.baseUrl || ''}${req.route.path}` : 'unmatched';
    httpRequestsTotal.inc({ method: req.method, route, status: String(res.statusCode) });
    if (!STREAMING_ROUTE.test(route)) {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      httpRequestDuration.observe({ method: req.method, route }, seconds);
    }
  });
  next();
}

/** GET /metrics. When `token` is set, requires `Authorization: Bearer
 * <token>` (Prometheus sends it via `authorization.credentials_file`); when
 * unset, the endpoint is open, which is the conventional default for a
 * scrape target that sits on a private network. */
export function metricsHandler({ token = '' } = {}) {
  return async (req, res) => {
    if (token) {
      const header = req.get('authorization') || '';
      if (header !== `Bearer ${token}`) return res.status(401).json({ error: 'unauthorized' });
    }
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  };
}

/** Records an admin-signed contract call's outcome. */
export function recordAdminInvocation(method, ok) {
  adminInvocationsTotal.inc({ method, result: ok ? 'ok' : 'error' });
}

/** Folds a job scan (see healthProbes.js) into the in-flight gauges. */
export function recordJobScan(jobs, now = Date.now()) {
  const byStatus = new Map();
  let oldestCreatedAt = null;
  for (const job of jobs) {
    if (!job || job.status === 'settled') continue;
    byStatus.set(job.status, (byStatus.get(job.status) || 0) + 1);
    const createdAt = job.createdAt ?? job.updatedAt;
    if (createdAt && (oldestCreatedAt === null || createdAt < oldestCreatedAt)) oldestCreatedAt = createdAt;
  }
  jobsInflight.reset();
  for (const [status, count] of byStatus) jobsInflight.set({ status }, count);
  oldestInflightJobAge.set(oldestCreatedAt === null ? 0 : Math.max(0, ms(now - oldestCreatedAt)));
}
