import test from 'node:test';
import assert from 'node:assert/strict';
import { context, trace, propagation, ROOT_CONTEXT } from '@opentelemetry/api';

import {
  registerCollector,
  getCollector,
  clearCollector,
  contextFromTraceparent,
  currentTraceparent,
} from '../src/dispatch.js';

test('registerCollector stores a collector retrievable by string id', () => {
  const questionId = 424242;
  const collector = registerCollector(questionId, {
    quorumSize: 3,
    finish: () => {},
  });

  assert.ok(collector);
  assert.equal(collector.quorumSize, 3);
  assert.equal(collector.finished, false);
  assert.ok(collector.submissions instanceof Map);

  const found = getCollector(String(questionId));
  assert.equal(found, collector);

  clearCollector(questionId);
});

test('clearCollector removes a registered collector', () => {
  const questionId = 515151;
  registerCollector(questionId, { quorumSize: 1, finish: () => {} });

  assert.ok(getCollector(String(questionId)));

  clearCollector(questionId);

  assert.equal(getCollector(String(questionId)), undefined);
});

test('contextFromTraceparent(undefined) returns the active context', () => {
  const active = context.active();
  assert.equal(contextFromTraceparent(undefined), active);
  assert.equal(contextFromTraceparent(null), active);
});

test('a valid traceparent round-trips through currentTraceparent', () => {
  const traceId = '0af7651916cd43dd8448eb211c80319c';
  const spanId = 'b7ad6b7169203331';
  const traceparent = `00-${traceId}-${spanId}-01`;

  const extracted = contextFromTraceparent(traceparent);
  const spanContext = trace.getSpanContext(extracted);
  assert.ok(spanContext);
  assert.equal(spanContext.traceId, traceId);
  assert.equal(spanContext.spanId, spanId);

  const roundTripped = context.with(extracted, () => currentTraceparent());
  assert.equal(roundTripped, traceparent);
});

test('currentTraceparent returns undefined without an active span', () => {
  const result = context.with(ROOT_CONTEXT, () => currentTraceparent());
  assert.equal(result, undefined);
});
