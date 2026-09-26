/**
 * HTTP fault injection for the alert drill (scripts/alert-drill.js).
 *
 * The drill proves the alerting pipeline end to end: it breaks something in
 * a running backend and checks that Prometheus -> Alertmanager actually
 * delivers the matching alert. Dependency faults (Redis, Soroban RPC, the
 * process itself) are injected for real, by stopping the dependency. HTTP
 * error-rate and latency faults have no external dependency to stop, so
 * they're injected here, in front of the real routes.
 *
 * Off unless ARBITER_FAULT_INJECTION=true, and securityPosture.js refuses to
 * start a production-looking deployment with it on. The control routes sit
 * behind the admin bearer token like every other /admin/* route.
 *
 * A fault is { id, type: 'http_error' | 'latency', pathPrefix, status?,
 * delayMs?, rate? } where `rate` (0..1, default 1) is the fraction of
 * matching requests affected.
 */

const FAULT_TYPES = new Set(['http_error', 'latency']);
const MAX_DELAY_MS = 30_000;

export function validateFault(input) {
  const fault = { ...input };
  if (!FAULT_TYPES.has(fault.type)) throw new Error(`type must be one of ${[...FAULT_TYPES].join(', ')}`);
  if (typeof fault.pathPrefix !== 'string' || !fault.pathPrefix.startsWith('/')) {
    throw new Error('pathPrefix must be a path starting with /');
  }
  if (fault.pathPrefix.startsWith('/admin') || fault.pathPrefix.startsWith('/metrics')) {
    // Never let a drill lock itself out of clearing the fault, or blind the scrape.
    throw new Error('faults cannot target /admin or /metrics');
  }
  fault.rate = fault.rate ?? 1;
  if (typeof fault.rate !== 'number' || fault.rate < 0 || fault.rate > 1) throw new Error('rate must be between 0 and 1');
  if (fault.type === 'http_error') {
    fault.status = fault.status ?? 503;
    if (!Number.isInteger(fault.status) || fault.status < 500 || fault.status > 599) {
      throw new Error('status must be a 5xx code');
    }
  } else {
    if (!Number.isInteger(fault.delayMs) || fault.delayMs < 1 || fault.delayMs > MAX_DELAY_MS) {
      throw new Error(`delayMs must be an integer between 1 and ${MAX_DELAY_MS}`);
    }
  }
  return { id: fault.id || `${fault.type}:${fault.pathPrefix}`, ...fault };
}

export function createFaultInjector({ random = Math.random } = {}) {
  const faults = new Map();

  function middleware(req, res, next) {
    let delayMs = 0;
    let errorStatus = null;
    for (const fault of faults.values()) {
      if (!req.path.startsWith(fault.pathPrefix) || random() >= fault.rate) continue;
      if (fault.type === 'latency') delayMs = Math.max(delayMs, fault.delayMs);
      else errorStatus ??= fault.status;
    }
    const proceed = () =>
      errorStatus ? res.status(errorStatus).json({ error: 'injected fault', injected: true }) : next();
    if (delayMs) setTimeout(proceed, delayMs);
    else proceed();
  }

  return {
    middleware,
    list: () => [...faults.values()],
    add(input) {
      const fault = validateFault(input);
      faults.set(fault.id, fault);
      return fault;
    },
    remove: (id) => faults.delete(id),
    clear: () => faults.clear(),
  };
}

/** Mounts GET/POST/DELETE /admin/faults on `app` behind `requireAdmin`. */
export function mountFaultRoutes(app, injector, requireAdmin) {
  app.get('/admin/faults', requireAdmin, (req, res) => res.json({ faults: injector.list() }));
  app.post('/admin/faults', requireAdmin, (req, res) => {
    try {
      res.status(201).json({ fault: injector.add(req.body || {}) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  app.delete('/admin/faults/:id', requireAdmin, (req, res) => {
    res.status(injector.remove(req.params.id) ? 204 : 404).end();
  });
  app.delete('/admin/faults', requireAdmin, (req, res) => {
    injector.clear();
    res.status(204).end();
  });
}
