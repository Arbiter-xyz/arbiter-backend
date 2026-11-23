import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { checkTreasuryBalance, resetTreasuryAlertState } from '../src/alerting.js';

test('checkTreasuryBalance logs and raises an alert when the fiat-pool balance cannot be read (#517)', async (t) => {
  resetTreasuryAlertState();
  const prevUrl = config.alerting.webhookUrl;
  const prevMinUsdc = config.alerting.treasuryMinUsdc;
  const prevPoolAddr = config.billing.fiatPoolAddress;
  const prevFetch = globalThis.fetch;

  const alerts = [];
  globalThis.fetch = async (url, opts) => {
    alerts.push(JSON.parse(opts.body));
    return { ok: true, status: 200 };
  };
  Object.defineProperty(config.alerting, 'webhookUrl', { value: 'https://hooks.example.com/alert', configurable: true });
  Object.defineProperty(config.alerting, 'treasuryMinUsdc', { value: 50, configurable: true });
  Object.defineProperty(config.billing, 'fiatPoolAddress', { value: 'GFIATPOOL', configurable: true });

  t.after(() => {
    globalThis.fetch = prevFetch;
    Object.defineProperty(config.alerting, 'webhookUrl', { value: prevUrl, configurable: true });
    Object.defineProperty(config.alerting, 'treasuryMinUsdc', { value: prevMinUsdc, configurable: true });
    Object.defineProperty(config.billing, 'fiatPoolAddress', { value: prevPoolAddr, configurable: true });
    resetTreasuryAlertState();
  });

  let shouldFail = true;
  const fakeGetTreasury = async () =>
    shouldFail
      ? {
          configured: true,
          platformAddress: 'GPLATFORM',
          xlmBalance: '100.0',
          usdcBalance: '200.0',
          fiatPool: null,
          fiatPoolError: 'Resource Missing (404)',
        }
      : {
          configured: true,
          platformAddress: 'GPLATFORM',
          xlmBalance: '100.0',
          usdcBalance: '200.0',
          fiatPool: { address: 'GFIATPOOL', xlmBalance: '20.0', usdcBalance: '150.0' },
        };

  await checkTreasuryBalance({ getTreasuryFn: fakeGetTreasury });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].key, 'treasury_fiat_pool_unreachable');
  assert.equal(alerts[0].details.address, 'GFIATPOOL');
  assert.match(alerts[0].details.error, /404/);

  // Repeated failure while already flagged does not spam duplicate alerts
  await checkTreasuryBalance({ getTreasuryFn: fakeGetTreasury });
  assert.equal(alerts.length, 1);

  // Recovery clears the unreachable flag so a future outage alerts again
  shouldFail = false;
  await checkTreasuryBalance({ getTreasuryFn: fakeGetTreasury });
  shouldFail = true;
  await checkTreasuryBalance({ getTreasuryFn: fakeGetTreasury });
  assert.equal(alerts.length, 2);
});
