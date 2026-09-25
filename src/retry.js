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
 *
 * Chaos/fault-injection testing (issue #8) surfaced two ways a remote
 * could still hang or wedge a job past the fail-closed boundary, both
 * fixed here:
 *   1. `withTimeout` only raced the promise — it never aborted the
 *      underlying work. A connection reset mid-response, or a socket that
 *      accepts the request then goes silent, left the in-flight call (and
 *      its socket) alive after we'd already moved on, so a retry could
 *      pile a second live call on top of a still-hung one.
 *   2. A remote that returns a truncated/malformed body (bad XDR, partial
 *      JSON) resolves the promise successfully, so it was never retried —
 *      the garbage flowed straight into the settle path. Callers can now
 *      pass `validate` to reject a malformed-but-2xx response so it is
 *      retried like any other transient failure.
 */

export async function withTimeout(fn, timeoutMs, label = 'operation') {
  let timer;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // Abort the underlying work so a hung socket/stream is torn down
      // instead of lingering past the fail-closed boundary.
      try {
        controller?.abort(new Error(`${label} timed out after ${timeoutMs}ms`));
      } catch {
        /* abort is best-effort; the race below still rejects */
      }
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(controller?.signal), timeout]);
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

/** A malformed/truncated response is a transient remote fault, not a
 * permanent one — mark it retryable so a bad XDR/partial body gets another
 * attempt instead of flowing into the settle path. */
export class MalformedResponseError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'MalformedResponseError';
    this.retryable = true;
    if (cause !== undefined) this.cause = cause;
  }
}

export async function withRetry(fn, options = {}) {
  const {
    attempts = 3,
    baseDelayMs = 200,
    timeoutMs,
    label = 'operation',
    isRetryable = defaultIsRetryable,
    validate,
  } = options;

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = timeoutMs ? await withTimeout(fn, timeoutMs, label) : await fn();
      // A 2xx response can still be garbage (truncated XDR, partial JSON).
      // Treat a failed validation as a retryable fault so it never reaches
      // the settle path as if it were a real answer.
      if (validate) {
        try {
          validate(result);
        } catch (err) {
          throw err instanceof MalformedResponseError
            ? err
            : new MalformedResponseError(`${label} returned a malformed response`, { cause: err });
        }
      }
      return result;
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
