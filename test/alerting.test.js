import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { checkTreasuryBalance, resetTreasuryAlertState } from '../src/alerting.js';

test('checkTreasuryBalance raises treasury_low_xlm once per state change when platform XLM drops below ALERT_TREASURY_MIN_XLM (#518)', async (t) => {
  resetTreasuryAlertState();
  const prevUrl = config.alerting.webhookUrl;
  const prevMinUsdc = config.alerting.treasuryMinUsdc;
  const prevMinXlm = config.alerting.treasuryMinXlm;
  const prevFetch = globalThis.fetch;

  const alerts = [];
  globalThis.fetch = async (url, opts) => {
    alerts.push(JSON.parse(opts.body));
    return { ok: true, status: 200 };
  };
  Object.defineProperty(config.alerting, 'webhookUrl', { value: 'https://hooks.example.com/alert', configurable: true });
  Object.defineProperty(config.alerting, 'treasuryMinUsdc', { value: 50, configurable: true });
  Object.defineProperty(config.alerting, 'treasuryMinXlm', { value: 10, configurable: true });

  t.after(() => {
    globalThis.fetch = prevFetch;
    Object.defineProperty(config.alerting, 'webhookUrl', { value: prevUrl, configurable: true });
    Object.defineProperty(config.alerting, 'treasuryMinUsdc', { value: prevMinUsdc, configurable: true });
    Object.defineProperty(config.alerting, 'treasuryMinXlm', { value: prevMinXlm, configurable: true });
    resetTreasuryAlertState();
  });

  let xlmBalance = '4.5';
  const fakeGetTreasury = async () => ({
    configured: true,
    platformAddress: 'GPLATFORM',
    xlmBalance,
    usdcBalance: '100.0',
    fiatPool: null,
  });

  // First crossing below threshold raises one alert
  await checkTreasuryBalance({ getTreasuryFn: fakeGetTreasury });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].key, 'treasury_low_xlm');
  assert.equal(alerts[0].details.xlmBalance, 4.5);
  assert.equal(alerts[0].details.thresholdXlm, 10);

  // Second poll while still low does not re-fire
  await checkTreasuryBalance({ getTreasuryFn: fakeGetTreasury });
  assert.equal(alerts.length, 1);

  // Recovery above threshold re-arms the state
  xlmBalance = '25.0';
  await checkTreasuryBalance({ getTreasuryFn: fakeGetTreasury });
  assert.equal(alerts.length, 1);

  // Subsequent drop below threshold fires again
  xlmBalance = '2.0';
  await checkTreasuryBalance({ getTreasuryFn: fakeGetTreasury });
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].key, 'treasury_low_xlm');
});
