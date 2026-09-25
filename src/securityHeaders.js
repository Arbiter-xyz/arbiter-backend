import { config } from './config.js';

/**
 * Second layer behind the source-level XSS fixes (admin.js, leaderboard.js,
 * anchor.js build DOM with createElement/textContent): if a future bug lets
 * untrusted markup through anyway, this policy keeps it from executing.
 * Hand-rolled instead of pulling in helmet — the header set is small and
 * fixed, and keeping it here makes the exact policy reviewable in one place.
 *
 * Tuned to what the frontends served by this backend actually load: same-origin
 * bundled scripts and styles, the backend's own API over fetch()/EventSource
 * (worker SSE stream, sandbox widget), a same-origin service worker for web
 * push, and data: URIs for small inline images. Nothing loads a third-party
 * script, so script-src is 'self' only — no 'unsafe-inline', no 'unsafe-eval'.
 * style-src allows 'unsafe-inline' because bundled UI frameworks set element
 * style attributes at runtime; style injection is a far weaker primitive than
 * script execution, and this is the one deliberate loosening.
 *
 * `connectSrc` lets a deployment whose frontend is hosted on a different
 * origin than the API (see ALLOWED_ORIGINS) add it here.
 */
export function buildCsp({ connectSrc = [] } = {}) {
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", ...connectSrc],
    'worker-src': ["'self'"],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

const HSTS_MAX_AGE_SECONDS = 15_552_000; // 180 days

/** Pure header set for a given config, so it's testable without a server. */
export function securityHeaders({ connectSrc = [], hsts = true } = {}) {
  const headers = {
    'Content-Security-Policy': buildCsp({ connectSrc }),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
  // Browsers ignore HSTS on plain http, so sending it unconditionally is
  // harmless for local dev — but it stays switchable for deployments that
  // terminate TLS somewhere HSTS shouldn't be asserted yet.
  if (hsts) headers['Strict-Transport-Security'] = `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`;
  return headers;
}

export function securityHeadersMiddleware(options = config.securityHeaders) {
  const headers = securityHeaders(options);
  return (req, res, next) => {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    next();
  };
}
