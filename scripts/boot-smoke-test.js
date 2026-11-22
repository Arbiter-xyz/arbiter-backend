#!/usr/bin/env node
// Boot smoke test (#469): `npm run check` only runs `node --check` per file,
// which catches syntax errors but NOT a missing/renamed named export, an
// undefined identifier referenced at module-eval time, or any other wiring
// break that only shows up when the real module graph is resolved and
// evaluated. 48 of the last 54 Wave-bounty PR merges left main unable to
// boot despite `npm run check` and `npm test` both being green, because
// none of CI actually imported the entrypoint end to end.
//
// This script imports src/server.js for real, with just enough env to get
// past config validation, and listens on an ephemeral port. Any throw
// (missing export, undefined ref, bad top-level await, etc.) fails loudly
// here instead of surfacing for the first time in production.
//
// Intentionally dependency-free beyond what src/server.js itself needs, so
// it can run as its own fast, early CI gate.

process.env.PORT = '0';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.REDIS_URL = process.env.REDIS_URL || ''; // force in-memory store fallback

const timeoutMs = 20_000;
const timer = setTimeout(() => {
  console.error(`boot-smoke-test: server did not finish starting within ${timeoutMs}ms`);
  process.exit(1);
}, timeoutMs);

try {
  await import('../src/server.js');
  clearTimeout(timer);
  console.log('boot-smoke-test: src/server.js imported and started cleanly');
  process.exit(0);
} catch (err) {
  clearTimeout(timer);
  console.error('boot-smoke-test: FAILED to boot');
  console.error(err);
  process.exit(1);
}
