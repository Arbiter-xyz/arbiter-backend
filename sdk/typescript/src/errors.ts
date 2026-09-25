/**
 * Every non-2xx response becomes an ArbiterError (or one of its subclasses
 * for the cases callers typically branch on). `body` is the parsed JSON the
 * backend returned, when there was any.
 */
export class ArbiterError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'ArbiterError';
    this.status = status;
    this.body = body;
  }
}

/** 402 — the question wasn't paid for: payment not visible on-chain yet, too
 * small, insufficient prepaid balance, or insufficient API credit. */
export class PaymentRequiredError extends ArbiterError {
  constructor(message: string, body?: unknown) {
    super(message, 402, body);
    this.name = 'PaymentRequiredError';
  }
}

/** 402 on the metered path: the payer's prepaid on-chain balance is too low.
 * `instructions` explains how to deposit() more. */
export class InsufficientBalanceError extends PaymentRequiredError {
  readonly payerAddress?: string;
  readonly instructions?: string;

  constructor(message: string, body?: { payerAddress?: string; instructions?: string }) {
    super(message, body);
    this.name = 'InsufficientBalanceError';
    this.payerAddress = body?.payerAddress;
    this.instructions = body?.instructions;
  }
}

/** 401 — missing, invalid, or expired session token or API key. */
export class AuthenticationError extends ArbiterError {
  constructor(message: string, body?: unknown) {
    super(message, 401, body);
    this.name = 'AuthenticationError';
  }
}

/** 429 — a per-IP rate limit was hit. `retryAfterMs` is set when the server said. */
export class RateLimitedError extends ArbiterError {
  readonly retryAfterMs?: number;

  constructor(message: string, body?: unknown, retryAfterMs?: number) {
    super(message, 429, body);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** 404 — unknown or expired job id. */
export class NotFoundError extends ArbiterError {
  constructor(message: string, body?: unknown) {
    super(message, 404, body);
    this.name = 'NotFoundError';
  }
}

/** 409 — e.g. cancelling a question after its undo window closed. */
export class ConflictError extends ArbiterError {
  constructor(message: string, body?: unknown) {
    super(message, 409, body);
    this.name = 'ConflictError';
  }
}

/** The request never got a response: network failure or client-side timeout. */
export class ArbiterNetworkError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ArbiterNetworkError';
    this.cause = cause;
  }
}

/** waitForResult() gave up before the job settled. The job itself may still settle. */
export class JobTimeoutError extends Error {
  readonly jobId: string;
  readonly lastStatus?: string;

  constructor(jobId: string, timeoutMs: number, lastStatus?: string) {
    super(`job ${jobId} did not settle within ${timeoutMs}ms (last status: ${lastStatus ?? 'unknown'})`);
    this.name = 'JobTimeoutError';
    this.jobId = jobId;
    this.lastStatus = lastStatus;
  }
}
