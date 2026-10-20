'use strict';

// Tests for the #125 escalation mechanism in src/jobs.js.
// Covers escalateItem / unescalateItem / getEscalatedItems / getEscalatedIds,
// which are shared by review-queue items and disputes.

const test = require('node:test');
const assert = require('node:assert');

const jobs = require('../src/jobs');

const {
  escalateItem,
  unescalateItem,
  getEscalatedItems,
  getEscalatedIds,
} = jobs;

test('escalation functions are exported', () => {
  assert.strictEqual(typeof escalateItem, 'function');
  assert.strictEqual(typeof unescalateItem, 'function');
  assert.strictEqual(typeof getEscalatedItems, 'function');
  assert.strictEqual(typeof getEscalatedIds, 'function');
});

test('escalateItem marks an item escalated and getEscalatedIds reflects it', () => {
  const id = 'test-escalate-' + Date.now();
  escalateItem(id, 'review-queue');
  const ids = getEscalatedIds();
  assert.ok(ids.includes(id), 'escalated id should be present in getEscalatedIds()');
});

test('getEscalatedItems includes escalated item with its metadata', () => {
  const id = 'test-escalate-items-' + Date.now();
  escalateItem(id, 'dispute');
  const items = getEscalatedItems();
  const found = items.find((it) => (it && (it.id === id || it.itemId === id)) || it === id);
  assert.ok(found, 'escalated item should appear in getEscalatedItems()');
});

test('unescalateItem removes a previously escalated item', () => {
  const id = 'test-unescalate-' + Date.now();
  escalateItem(id, 'review-queue');
  assert.ok(getEscalatedIds().includes(id));
  unescalateItem(id);
  assert.ok(!getEscalatedIds().includes(id), 'unescalated id should no longer be present');
});

test('unescalateItem on a non-escalated item is a no-op', () => {
  const id = 'test-unescalate-missing-' + Date.now();
  assert.doesNotThrow(() => unescalateItem(id));
  assert.ok(!getEscalatedIds().includes(id));
});

test('escalating the same item twice does not duplicate it', () => {
  const id = 'test-escalate-twice-' + Date.now();
  escalateItem(id, 'review-queue');
  escalateItem(id, 'review-queue');
  const matches = getEscalatedIds().filter((x) => x === id);
  assert.strictEqual(matches.length, 1, 'id should appear exactly once');
  unescalateItem(id);
});
