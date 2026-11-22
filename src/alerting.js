import { config } from './config.js';
import { logger } from './logger.js';
import { getTreasury } from './admin.js';

/**
 * On-call alerting. The failure paths that already produce a tagged job
 * outcome (refund_pending_timeout, fulfillment crash) call raiseAlert()
 * directly, so the alert and the job record come from the same code path
 * rather than from a log scraper re-deriving the condition.
 *
 * Delivery is fire-and-forget: a slow or dead receiver must never delay or
 * fail settlement, so raiseAlert() returns immediately and never throws.
 * Every alert is one POST per event — there's no aggregation window yet, on
 * the theory that a refund that couldn't be refunded or resolved is never a
 * transient blip worth suppressing.
 *
 * Only a generic JSON webhook for now. PagerDuty's Events API wants a
 * routing key and a severity model that doesn't map onto this payload, so
 * it's a follow-up rather than a guess baked in here.
 */

export function isAlertingConfigured() {
  return Boolean(config.alerting.webhookUrl);
}

export function raiseAlert(key, summary, details = {}) {
  if (!isAlertingConfigured()) return;
  const payload = {
    text: `[arbiter] ${key}: ${summary}`,
    key,
    summary,
    details,
    source: 'arbiter-backend',
    ts: new Date().toISOString(),
  };
  fetch(config.alerting.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  })
    .then((res) => {
      if (!res.ok) logger.error({ key, status: res.status }, 'alert webhook rejected the alert');
    })
    .catch((err) => logger.error({ err, key }, 'alert webhook delivery failed'));
}

// Edge-triggered: one alert on the crossing below the threshold, not one per
// poll while it stays below. Keyed by balance label so the platform and
// fiat-pool addresses each track their own state.
const lowBalanceState = new Map();

function evaluateBalance(label, address, usdcBalance, minUsdc) {
  const balance = Number(usdcBalance);
  const low = balance < minUsdc;
  if (low && !lowBalanceState.get(label)) {
    raiseAlert('treasury_low_balance', `${label} USDC balance ${balance} is below ${minUsdc}`, {
      account: label,
      address,
      usdcBalance: balance,
      thresholdUsdc: minUsdc,
    });
  }
  if (!low && lowBalanceState.get(label)) {
    logger.info({ account: label, usdcBalance: balance }, 'treasury balance recovered above threshold');
  }
  lowBalanceState.set(label, low);
}

export async function checkTreasuryBalance() {
  const minUsdc = config.alerting.treasuryMinUsdc;
  if (minUsdc == null || !isAlertingConfigured()) return;
  const treasury = await getTreasury();
  if (!treasury.configured) return;
  evaluateBalance('platform', treasury.platformAddress, treasury.usdcBalance, minUsdc);
  if (treasury.fiatPool) {
    evaluateBalance('fiat_pool', treasury.fiatPool.address, treasury.fiatPool.usdcBalance, minUsdc);
  }
}

export function startTreasuryMonitor() {
  if (config.alerting.treasuryMinUsdc == null || !isAlertingConfigured()) return null;
  const run = () => checkTreasuryBalance().catch((err) => logger.warn({ err }, 'treasury balance check failed'));
  run();
  const timer = setInterval(run, config.alerting.treasuryIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
