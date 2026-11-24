import test from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { REDACT_CONFIG, genReqId, httpLogger } from '../src/logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// #522: the client-supplied x-request-id must be bounded and sanitized before
// it is used as the request id that appears in every log line for the request.
test('a valid x-request-id is used verbatim', () => {
  const id = 'abc-123_XYZ.789';
  assert.equal(genReqId({ headers: { 'x-request-id': id } }), id);
});

test('a 128-character x-request-id is still accepted', () => {
  const id = 'a'.repeat(128);
  assert.equal(genReqId({ headers: { 'x-request-id': id } }), id);
});

test('an oversized x-request-id is replaced by a UUID', () => {
  const id = genReqId({ headers: { 'x-request-id': 'a'.repeat(129) } });
  assert.match(id, UUID_RE);
  assert.notEqual(id, 'a'.repeat(129));
});

test('an x-request-id with control characters is replaced by a UUID', () => {
  const id = genReqId({ headers: { 'x-request-id': 'abc\n123' } });
  assert.match(id, UUID_RE);
});

test('an x-request-id with disallowed characters is replaced by a UUID', () => {
  for (const bad of ['has space', 'semi;colon', '<script>', 'emoji😀', '']) {
    assert.match(genReqId({ headers: { 'x-request-id': bad } }), UUID_RE, `expected UUID for ${JSON.stringify(bad)}`);
  }
});

test('a missing x-request-id yields a UUID', () => {
  assert.match(genReqId({ headers: {} }), UUID_RE);
});

test('the chosen request id is echoed in the X-Request-Id response header', () => {
  const res = { setHeader: (name, value) => { res.headers = { ...(res.headers || {}), [name]: value }; } };
  const req = { headers: { 'x-request-id': 'client-supplied-id' } };

  const id = httpLogger.genReqId(req, res);
  assert.equal(id, 'client-supplied-id');
  assert.equal(res.headers['X-Request-Id'], 'client-supplied-id');
});

test('an invalid request id is replaced and the replacement is echoed back', () => {
  const res = { setHeader: (name, value) => { res.headers = { ...(res.headers || {}), [name]: value }; } };
  const req = { headers: { 'x-request-id': 'x'.repeat(500) } };

  const id = httpLogger.genReqId(req, res);
  assert.match(id, UUID_RE);
  assert.equal(res.headers['X-Request-Id'], id);
});
