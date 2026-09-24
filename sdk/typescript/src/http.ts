import {
  ArbiterError,
  ArbiterNetworkError,
  AuthenticationError,
  ConflictError,
  InsufficientBalanceError,
  NotFoundError,
  PaymentRequiredError,
  RateLimitedError,
} from './errors.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  baseUrl: string;
  fetch: FetchLike;
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
}

export interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Whether a failed attempt may be sent again. Only true for requests
   * that are harmless to repeat: every GET, the session challenge/response
   * calls, and the classic payment-submit step (the backend's claimJob()
   * makes that one idempotent on questionId). Never true for the metered or
   * API-key POST /oracle — if the response was lost after the charge
   * landed, a retry would charge a second time.
   */
  retry: boolean;
  /** Status codes that are an expected, successful answer for this call (e.g. 402 for a challenge). */
  acceptStatus?: number[];
  signal?: AbortSignal;
}

export interface HttpResponse<T> {
  status: number;
  body: T;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function buildUrl(baseUrl: string, path: string, query?: RequestSpec['query']): string {
  const url = new URL(path.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const { error, reason } = body as { error?: unknown; reason?: unknown };
    if (typeof error === 'string') return error;
    if (typeof reason === 'string') return reason;
  }
  return fallback;
}

/** Maps a non-accepted response to the matching error class. */
export function toArbiterError(status: number, body: unknown, retryAfter?: number): ArbiterError {
  const message = errorMessage(body, `Arbiter API responded with HTTP ${status}`);
  switch (status) {
    case 401:
      return new AuthenticationError(message, body);
    case 402:
      return body && typeof body === 'object' && 'instructions' in body && 'payerAddress' in body
        ? new InsufficientBalanceError(message, body as { payerAddress?: string; instructions?: string })
        : new PaymentRequiredError(message, body);
    case 404:
      return new NotFoundError(message, body);
    case 409:
      return new ConflictError(message, body);
    case 429:
      return new RateLimitedError(message, body, retryAfter);
    default:
      return new ArbiterError(message, status, body);
  }
}

export async function request<T>(options: HttpOptions, spec: RequestSpec): Promise<HttpResponse<T>> {
  const url = buildUrl(options.baseUrl, spec.path, spec.query);
  const attempts = spec.retry ? options.maxRetries + 1 : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(spec.signal?.reason);
    spec.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs);

    let res: Response;
    try {
      res = await options.fetch(url, {
        method: spec.method,
        headers: {
          Accept: 'application/json',
          ...(spec.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...spec.headers,
        },
        body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);
      if (spec.signal?.aborted) throw spec.signal.reason ?? err;
      lastError = new ArbiterNetworkError(
        controller.signal.aborted
          ? `${spec.method} ${spec.path} timed out after ${options.timeoutMs}ms`
          : `${spec.method} ${spec.path} failed: ${(err as Error)?.message ?? err}`,
        err,
      );
      if (attempt < attempts) {
        await sleep(options.retryBaseDelayMs * 2 ** (attempt - 1));
        continue;
      }
      throw lastError;
    }
    clearTimeout(timer);
    spec.signal?.removeEventListener('abort', onAbort);

    const text = await res.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (res.ok || spec.acceptStatus?.includes(res.status)) {
      return { status: res.status, body: body as T };
    }

    const wait = retryAfterMs(res);
    lastError = toArbiterError(res.status, body, wait);
    if (attempt < attempts && RETRYABLE_STATUS.has(res.status)) {
      await sleep(wait ?? options.retryBaseDelayMs * 2 ** (attempt - 1));
      continue;
    }
    throw lastError;
  }

  throw lastError;
}
