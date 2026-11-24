import { config } from './config.js';
import { logger } from './logger.js';
import { getTreasury } from './admin.js';
import { getStore } from './store.js';

/**
 * On-call alerting. The failure paths that already produce a tagged job
 * outcome (refund_pending_timeout, fulfillment crash) call raiseAlert()
 * directly, so the alert and the job record come from the same code path
 * rather than from a log scraper re-deriving the condition.
 *
 * Delivery is fire-and-forget: a slow or dead receiver must never delay or
 * fail settlement, so raiseAlert() returns immediately and never throws.
 * Repeated alerts with the same key are throttled: within the cooldown the
 * alert is suppressed and counted, and the next delivered alert carries the
 * suppressed count. The cooldown state lives in the shared store so it holds
 * across instances.
 *
 * Only a generic JSON webhook for now. PagerDuty's Events API wants a
 * routing key and a severity model that doesn't map onto this payload, so
 * it's a follow-up rather than a guess baked in here.
 */

export function isAlertingConfigured() {
  return Boolean(config.alerting.webhookUrl);
}

const ALERT_COOLDOWN_PREFIX = 'alert_cooldown:';

// Returns { deliver, suppressed } for this key at `now`. Suppressed alerts
// bump the counter; the first alert after the cooldown expires delivers with
// the accumulated count and resets it.
function throttleAlert(key, now) {
  const store = getStore();
  const storeKey = `${ALERT_COOLDOWN_PREFIX}${key}`;
  const state = store.get(storeKey);
  if (state && now - state.lastSentAt < config.alerting.cooldownMs) {
    store.set(storeKey, { lastSentAt: state.lastSentAt, suppressed: (state.suppressed || 0) + 1 });
    return { deliver: false, suppressed: 0 };
  }
  const suppressed = state?.suppressed || 0;
  store.set(storeKey, { lastSentAt: now, suppressed: 0 });
  return { deliver: true, suppressed };
}

export function raiseAlert(key, summary, details = {}) {
  if (!isAlertingConfigured()) return;
  try {
    const { deliver, suppressed } = throttleAlert(key, Date.now());
    if (!deliver) {
      logger.debug({ key }, 'alert suppressed by cooldown');
      return;
    }
    const payload = {
      text: `[arbiter] ${key}: ${summary}`,
      key,
      summary,
      details: suppressed > 0 ? { ...details, suppressedAlerts: suppressed } : details,
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
  } catch (err) {
    logger.error({ err, key }, 'raiseAlert failed');
  }
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

function evaluateXlmBalance(label, address, xlmBalance, minXlm) {
  const balance = Number(xlmBalance);
  const low = balance < minXlm;
  if (low && !lowBalanceState.get(label)) {
    raiseAlert('treasury_low_xlm', `${label} XLM balance ${balance} is below ${minXlm}`, {
      account: label,
      address,
      xlmBalance: balance,
      thresholdXlm: minXlm,
    });
  }
  if (!low && lowBalanceState.get(label)) {
    logger.info({ account: label, xlmBalance: balance }, 'treasury XLM balance recovered above threshold');
  }
  lowBalanceState.set(label, low);
}

export async function checkTreasuryBalance() {
  const minUsdc = config.alerting.treasuryMinUsdc;
  const minXlm = config.alerting.treasuryMinXlm;
  if ((minUsdc == null && minXlm == null) || !isAlertingConfigured()) return;
  const treasury = await getTreasury();
  if (!treasury.configured) return;
  if (minUsdc != null) {
    evaluateBalance('platform', treasury.platformAddress, treasury.usdcBalance, minUsdc);
    if (treasury.fiatPool) {
      evaluateBalance('fiat_pool', treasury.fiatPool.address, treasury.fiatPool.usdcBalance, minUsdc);
    }
  }
  if (minXlm != null) {
    evaluateXlmBalance('platform_xlm', treasury.platformAddress, treasury.xlmBalance, minXlm);
  }
}

export function startTreasuryMonitor() {
  if (
    (config.alerting.treasuryMinUsdc == null && config.alerting.treasuryMinXlm == null) ||
    !isAlertingConfigured()
  ) {
    return null;
  }
  const run = () => checkTreasuryBalance().catch((err) => logger.warn({ err }, 'treasury balance check failed'));
  run();
  const timer = setInterval(run, config.alerting.treasuryIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
