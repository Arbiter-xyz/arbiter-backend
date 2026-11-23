import test from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { REDACT_CONFIG, resolveRequestId } from '../src/logger.js';

// Regression coverage: pino-http's default req serializer logs the full
// request headers object, including Authorization — every admin bearer
// token, ak_live_ API key, and session token would otherwise land verbatim
// in every request log line. Constructs a real pino instance with the
// app's exact exported redact config, writing to a synchronous in-memory
// stream, so this proves the actual mechanism rather than just asserting
// on the config shape.
function captureLogger() {
  const lines = [];
  const stream = { write: (chunk) => lines.push(chunk) };
  return { logger: pino({ redact: REDACT_CONFIG }, stream), lines };
}

test('the Authorization header is redacted, not logged verbatim', () => {
  const { logger, lines } = captureLogger();
  logger.info({ req: { headers: { authorization: 'Bearer super-secret-admin-token' } } }, 'request');

  const logged = lines.join('');
  assert.ok(!logged.includes('super-secret-admin-token'), 'the raw secret must never appear in the log output');
  assert.ok(logged.includes('[redacted]'));
});

test('an API key sent via Authorization is redacted the same way', () => {
  const { logger, lines } = captureLogger();
  logger.info({ req: { headers: { authorization: 'Bearer ak_live_abcdef0123456789' } } }, 'request');

  assert.ok(!lines.join('').includes('ak_live_abcdef0123456789'));
});

test('other headers are logged normally — redaction is scoped, not blanket', () => {
  const { logger, lines } = captureLogger();
  logger.info({ req: { headers: { authorization: 'Bearer secret', 'content-type': 'application/json' } } }, 'request');

  assert.ok(lines.join('').includes('application/json'));
});

test('resolveRequestId accepts valid bounded X-Request-Id and echoes it on response', () => {
  const headers = {};
  const req = { headers: { 'x-request-id': 'req_2026-11.abc_123' } };
  const res = { setHeader: (k, v) => { headers[k] = v; } };
  const id = resolveRequestId(req, res);
  assert.equal(id, 'req_2026-11.abc_123');
  assert.equal(headers['X-Request-Id'], 'req_2026-11.abc_123');
});

test('resolveRequestId replaces oversized or control-character X-Request-Id with a fresh UUID', () => {
  for (const bad of ['a'.repeat(129), 'bad\nheader', 'bad space', '', 'bad$char']) {
    const headers = {};
    const req = { headers: { 'x-request-id': bad } };
    const res = { setHeader: (k, v) => { headers[k] = v; } };
    const id = resolveRequestId(req, res);
    assert.notEqual(id, bad);
    assert.match(id, /^[0-9a-f-]{36}$/i);
    assert.equal(headers['X-Request-Id'], id);
  }
});
