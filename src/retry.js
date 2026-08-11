import { logger } from './logger.js';

/**
 * Every external call in this system (Claude, Soroban RPC, Horizon) was
 * previously unbounded — no timeout, so a hung remote could stall a
 * request indefinitely, and no retry, so a single transient blip (a
 * dropped connection, a momentary 503) immediately fell through to the
 * fail-closed refund path instead of just trying again. Bounded and short
 * on purpose: this system settles money, so "retry for 30 seconds" is the
 * wrong instinct — a few fast attempts, then let the existing fail-closed
 * design (refund, or the permissionless refund_timeout escape hatch) take
 * over, exactly as it already does for a genuinely broken dependency.
 */

export async function withTimeout(fn, timeoutMs, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const DEFAULT_RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** Best-effort classification: network-level failures (no response at all)
 * and 429/5xx are worth retrying; 4xx client/auth/validation errors are
 * not — retrying an invalid request just wastes the retry budget on an
 * outcome that can never change. */
function defaultIsRetryable(err) {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (status === undefined) return true; // no HTTP status at all -> network/timeout-shaped failure
  return DEFAULT_RETRYABLE_STATUS.has(status);
}

export async function withRetry(fn, options = {}) {
  const { attempts = 3, baseDelayMs = 200, timeoutMs, label = 'operation', isRetryable = defaultIsRetryable } = options;

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return timeoutMs ? await withTimeout(fn, timeoutMs, label) : await fn();
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < attempts && isRetryable(err);
      if (!canRetry) throw err;
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      logger.warn({ err, attempt, attempts, label, delayMs }, `${label} failed, retrying`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}
