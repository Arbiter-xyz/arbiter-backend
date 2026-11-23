import test from 'node:test';
import assert from 'node:assert/strict';

import { appendAuditLog, listAuditLog } from '../src/auditLog.js';
import { store } from '../src/store.js';

const AUDIT_LOG_KEY = 'audit:log';
const MAX_TRACKED_ENTRIES = 5000;

async function resetAuditLog() {
  await store.set(AUDIT_LOG_KEY, []);
}

test('appendAuditLog returns an entry with id, action, actor, and at', async () => {
  await resetAuditLog();

  const entry = await appendAuditLog({
    action: 'dispatch.created',
    actor: 'alice',
    target: 'job-1',
    metadata: { foo: 'bar' },
  });

  assert.equal(typeof entry.id, 'string');
  assert.ok(entry.id.length > 0);
  assert.equal(entry.action, 'dispatch.created');
  assert.equal(entry.actor, 'alice');
  assert.equal(entry.target, 'job-1');
  assert.deepEqual(entry.metadata, { foo: 'bar' });
  assert.equal(typeof entry.at, 'string');
  assert.ok(!Number.isNaN(Date.parse(entry.at)));
});

test('appendAuditLog stores entries newest-first', async () => {
  await resetAuditLog();

  await appendAuditLog({ action: 'first', actor: 'alice' });
  await appendAuditLog({ action: 'second', actor: 'alice' });
  await appendAuditLog({ action: 'third', actor: 'alice' });

  const entries = await listAuditLog();
  assert.deepEqual(
    entries.map((e) => e.action),
    ['third', 'second', 'first'],
  );
});

test('appendAuditLog caps the stored list at MAX_TRACKED_ENTRIES', async () => {
  await resetAuditLog();

  const existing = Array.from({ length: MAX_TRACKED_ENTRIES }, (_, i) => ({
    id: `seed-${i}`,
    action: 'seed',
    actor: 'system',
    target: null,
    metadata: null,
    at: new Date().toISOString(),
  }));
  await store.set(AUDIT_LOG_KEY, existing);

  await appendAuditLog({ action: 'newest', actor: 'alice' });

  const stored = await store.get(AUDIT_LOG_KEY);
  assert.equal(stored.length, MAX_TRACKED_ENTRIES);
  assert.equal(stored[0].action, 'newest');
  assert.equal(stored[stored.length - 1].id, `seed-${MAX_TRACKED_ENTRIES - 2}`);
});

test('listAuditLog filters by actor and truncates by limit', async () => {
  await resetAuditLog();

  await appendAuditLog({ action: 'a1', actor: 'alice' });
  await appendAuditLog({ action: 'b1', actor: 'bob' });
  await appendAuditLog({ action: 'a2', actor: 'alice' });
  await appendAuditLog({ action: 'a3', actor: 'alice' });

  const aliceEntries = await listAuditLog({ actor: 'alice' });
  assert.deepEqual(
    aliceEntries.map((e) => e.action),
    ['a3', 'a2', 'a1'],
  );

  const limited = await listAuditLog({ actor: 'alice', limit: 2 });
  assert.deepEqual(
    limited.map((e) => e.action),
    ['a3', 'a2'],
  );

  const allLimited = await listAuditLog({ limit: 1 });
  assert.equal(allLimited.length, 1);
  assert.equal(allLimited[0].action, 'a3');
});
