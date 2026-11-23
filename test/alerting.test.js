import test from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import {
  raiseAlert,
  checkTreasuryBalance,
  startTreasuryMonitor,
} from '../src/alerting.js';

function withWebhook(url, fn) {
  const original = config.alerting?.webhookUrl;
  if (!config.alerting) config.alerting = {};
  config.alerting.webhookUrl = url;
  try {
    return fn();
  } finally {
    config.alerting.webhookUrl = original;
  }
}

function captureFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test('raiseAlert is a no-op when no webhook URL is configured', async () => {
  const cap = captureFetch();
  try {
    await withWebhook(undefined, () => raiseAlert('k', 'summary', { a: 1 }));
    assert.equal(cap.calls.length, 0);
  } finally {
    cap.restore();
  }
});

test('raiseAlert posts a payload when configured', async () => {
  const cap = captureFetch();
  try {
    await withWebhook('https://example.test/hook', () =>
      raiseAlert('k', 'summary', { a: 1 }),
    );
    assert.equal(cap.calls.length, 1);
    assert.equal(cap.calls[0].url, 'https://example.test/hook');
    assert.equal(cap.calls[0].opts.method, 'POST');
    const body = JSON.parse(cap.calls[0].opts.body);
    assert.equal(body.key, 'k');
    assert.equal(body.summary, 'summary');
    assert.deepEqual(body.details, { a: 1 });
  } finally {
    cap.restore();
  }
});

test('crossing below threshold alerts once, staying low does not re-alert, recovery logs', async () => {
  const cap = captureFetch();
  try {
    await withWebhook('https://example.test/hook', async () => {
      // Healthy: no alert.
      await checkTreasuryBalance({ balance: 100, threshold: 50 });
      assert.equal(cap.calls.length, 0);

      // Crossing below threshold: alert once.
      await checkTreasuryBalance({ balance: 40, threshold: 50 });
      assert.equal(cap.calls.length, 1);

      // Staying low: no re-alert.
      await checkTreasuryBalance({ balance: 30, threshold: 50 });
      assert.equal(cap.calls.length, 1);

      // Recovery: logs, no alert.
      await checkTreasuryBalance({ balance: 80, threshold: 50 });
      assert.equal(cap.calls.length, 1);
    });
  } finally {
    cap.restore();
  }
});

test('platform and fiat-pool states are tracked independently', async () => {
  const cap = captureFetch();
  try {
    await withWebhook('https://example.test/hook', async () => {
      await checkTreasuryBalance({ balance: 40, threshold: 50, pool: 'platform' });
      assert.equal(cap.calls.length, 1);

      // Fiat pool crossing alerts independently even though platform is already low.
      await checkTreasuryBalance({ balance: 10, threshold: 20, pool: 'fiat' });
      assert.equal(cap.calls.length, 2);

      // Platform staying low does not re-alert.
      await checkTreasuryBalance({ balance: 35, threshold: 50, pool: 'platform' });
      assert.equal(cap.calls.length, 2);
    });
  } finally {
    cap.restore();
  }
});

test('startTreasuryMonitor returns null when unconfigured', () => {
  withWebhook(undefined, () => {
    const handle = startTreasuryMonitor();
    assert.equal(handle, null);
  });
});
