import test from 'node:test';
import assert from 'node:assert/strict';
import webpush from 'web-push';
import {
  saveSubscription,
  removeSubscription,
  hasSubscription,
  getPushEligibleWorkerIds,
  notifyWorker,
  isPushConfigured,
} from '../src/push.js';

const fakeSubscription = (id) => ({
  endpoint: `https://push.example.com/fake-endpoint/${id}`,
  keys: { p256dh: 'fake-p256dh', auth: 'fake-auth' },
});

test('save/has/remove subscription round-trips correctly', async () => {
  const worker = `w-${Date.now()}`;
  assert.equal(await hasSubscription(worker), false);

  await saveSubscription(worker, fakeSubscription(worker), []);
  assert.equal(await hasSubscription(worker), true);

  await removeSubscription(worker);
  assert.equal(await hasSubscription(worker), false);
});

test('getPushEligibleWorkerIds: a generalist (no categories) matches every category', async () => {
  const worker = `generalist-${Date.now()}`;
  await saveSubscription(worker, fakeSubscription(worker), []);
  try {
    assert.ok(getPushEligibleWorkerIds('math').includes(worker));
    assert.ok(getPushEligibleWorkerIds('history').includes(worker));
    assert.ok(getPushEligibleWorkerIds(undefined).includes(worker));
  } finally {
    await removeSubscription(worker);
  }
});

test('getPushEligibleWorkerIds: a specialist only matches its declared categories', async () => {
  const worker = `specialist-${Date.now()}`;
  await saveSubscription(worker, fakeSubscription(worker), ['Math']); // mixed case on purpose
  try {
    assert.ok(getPushEligibleWorkerIds('math').includes(worker), 'category matching must be case-insensitive');
    assert.ok(!getPushEligibleWorkerIds('history').includes(worker));
  } finally {
    await removeSubscription(worker);
  }
});

test('notifyWorker returns false without throwing when VAPID is not configured', async () => {
  // Default test environment has no VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY set.
  if (isPushConfigured()) return; // skip if some other test in this run configured it
  const worker = `unconfigured-${Date.now()}`;
  await saveSubscription(worker, fakeSubscription(worker), []);
  try {
    const result = await notifyWorker(worker, { title: 'test' });
    assert.equal(result, false);
  } finally {
    await removeSubscription(worker);
  }
});

test('notifyWorker returns false for a worker with no subscription at all', async () => {
  const result = await notifyWorker(`never-subscribed-${Date.now()}`, { title: 'test' });
  assert.equal(result, false);
});

test('notifyWorker never throws even when the push service is unreachable (fake endpoint + real VAPID keys)', async () => {
  const keys = webpush.generateVAPIDKeys();
  webpush.setVapidDetails('mailto:test@example.com', keys.publicKey, keys.privateKey);

  const worker = `unreachable-endpoint-${Date.now()}`;
  await saveSubscription(worker, fakeSubscription(worker), []);
  try {
    // A fake, unresolvable endpoint host means sendNotification's HTTP call
    // fails at the network layer (no statusCode) rather than getting a
    // real 404/410 — notifyWorker must swallow this cleanly either way.
    const result = await notifyWorker(worker, { title: 'test', body: 'body' });
    assert.equal(result, false);
    // Subscription should NOT be removed on a generic network failure —
    // only on a confirmed 404/410 "this subscription is gone" response.
    assert.equal(await hasSubscription(worker), true);
  } finally {
    await removeSubscription(worker);
  }
});
