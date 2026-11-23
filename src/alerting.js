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

export function resetTreasuryAlertState() {
  lowBalanceState.clear();
}

export async function checkTreasuryBalance({ getTreasuryFn = getTreasury } = {}) {
  const minUsdc = config.alerting.treasuryMinUsdc;
  if (minUsdc == null || !isAlertingConfigured()) return;
  const treasury = await getTreasuryFn();
  if (!treasury.configured) return;
  evaluateBalance('platform', treasury.platformAddress, treasury.usdcBalance, minUsdc);
  if (treasury.fiatPool) {
    if (lowBalanceState.get('fiat_pool:unreachable')) {
      logger.info({ address: treasury.fiatPool.address }, 'fiat-pool balance lookup recovered');
      lowBalanceState.set('fiat_pool:unreachable', false);
    }
    evaluateBalance('fiat_pool', treasury.fiatPool.address, treasury.fiatPool.usdcBalance, minUsdc);
  } else if (treasury.fiatPoolError || config.billing.fiatPoolAddress) {
    const address = config.billing.fiatPoolAddress;
    const error = treasury.fiatPoolError || 'fiat-pool account balance could not be loaded';
    logger.error({ address, error }, 'failed to read fiat-pool balance from Horizon');
    if (!lowBalanceState.get('fiat_pool:unreachable')) {
      raiseAlert('treasury_fiat_pool_unreachable', `fiat_pool balance at ${address} could not be read: ${error}`, {
        account: 'fiat_pool',
        address,
        error,
      });
      lowBalanceState.set('fiat_pool:unreachable', true);
    }
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
