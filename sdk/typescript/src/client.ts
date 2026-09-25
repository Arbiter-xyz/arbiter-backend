import { JobTimeoutError, PaymentRequiredError } from './errors.ts';
import { request, type FetchLike, type HttpOptions, type RequestSpec } from './http.ts';
import type {
  Job,
  LeaderboardEntry,
  OracleAccepted,
  PayerBalance,
  PayerQuestions,
  PaymentChallenge,
  SandboxAccepted,
  SandboxSimulation,
  Session,
  Stats,
  TierKey,
  WorkerOwed,
  WorkerReputation,
  WorkerStake,
} from './types.ts';

export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
export const PUBLIC_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

/**
 * Signs a challenge transaction (base64 XDR) as the payer and returns the
 * signed XDR. In a browser this is typically a wallet call (e.g. Freighter's
 * signTransaction); in Node, `keypairSigner()` from `@arbiter-xyz/sdk/stellar`.
 */
export type TransactionSigner = (xdr: string, networkPassphrase: string) => string | Promise<string>;

export interface ArbiterClientOptions {
  /** Backend origin, e.g. `https://api.arbiter.example` or `http://localhost:4000`. */
  baseUrl: string;
  /** `ak_live_...` key for the API-key payment path. Only sent on the calls that use it. */
  apiKey?: string;
  /** Network the backend signs challenges for. Defaults to testnet. */
  networkPassphrase?: string;
  /** Per-attempt request timeout. Default 15s. */
  timeoutMs?: number;
  /** Extra attempts for requests that are safe to repeat. Default 2. */
  maxRetries?: number;
  /** First retry delay, doubled per attempt. Default 300ms. */
  retryBaseDelayMs?: number;
  /** Custom fetch (tests, proxies, older runtimes). Defaults to the global fetch. */
  fetch?: FetchLike;
}

export interface AskOptions {
  tier?: TierKey;
  category?: string;
}

export interface WaitOptions {
  /** Delay between polls. Default 1s. */
  intervalMs?: number;
  /** Give up (JobTimeoutError) after this long. Default 5 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with every polled job record, including the final one. */
  onUpdate?: (job: Job) => void;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

const enc = encodeURIComponent;

export class ArbiterClient {
  readonly networkPassphrase: string;
  private readonly http: HttpOptions;
  private readonly apiKey?: string;

  constructor(options: ArbiterClientOptions) {
    if (!options?.baseUrl) throw new TypeError('ArbiterClient: baseUrl is required');
    const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!fetchImpl) throw new TypeError('ArbiterClient: no global fetch available — pass options.fetch');

    this.apiKey = options.apiKey;
    this.networkPassphrase = options.networkPassphrase ?? TESTNET_PASSPHRASE;
    this.http = {
      baseUrl: options.baseUrl,
      fetch: fetchImpl,
      timeoutMs: options.timeoutMs ?? 15_000,
      maxRetries: options.maxRetries ?? 2,
      retryBaseDelayMs: options.retryBaseDelayMs ?? 300,
    };
  }

  private async call<T>(spec: RequestSpec): Promise<T> {
    return (await request<T>(this.http, spec)).body;
  }

  // ------------------------------------------------------------------
  // Asking questions — three payment paths on one endpoint.
  // ------------------------------------------------------------------

  /**
   * Classic flow, step 1: get a quote and a questionId. Pay it on-chain by
   * calling the contract's `submit(payer, questionId, amountStroops)`
   * yourself, then call {@link submitPayment}. Pass `idempotencyKey` so a
   * retry after a lost response returns the same questionId instead of a new one.
   */
  async requestChallenge(question: string, options: AskOptions & { idempotencyKey?: string } = {}): Promise<PaymentChallenge> {
    return this.call<PaymentChallenge>({
      method: 'POST',
      path: '/oracle',
      body: { question, tier: options.tier, category: options.category },
      headers: options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : undefined,
      acceptStatus: [402],
      // Only safe to repeat with a key; without one each call mints a new questionId.
      retry: Boolean(options.idempotencyKey),
    });
  }

  /**
   * Classic flow, step 2: tell the backend the submit() landed. Returns once
   * payment is verified (202); poll the job for the answer. While the
   * backend still reports "payment not yet visible on-chain", this keeps
   * re-checking every `pollIntervalMs` for up to `waitForPaymentMs`
   * (default 30s), since RPC nodes can lag a few seconds behind a
   * transaction that already succeeded.
   */
  async submitPayment(
    params: { questionId: string; paymentTx: string },
    options: { waitForPaymentMs?: number; pollIntervalMs?: number; signal?: AbortSignal } = {},
  ): Promise<OracleAccepted> {
    const deadline = Date.now() + (options.waitForPaymentMs ?? 30_000);
    for (;;) {
      try {
        return await this.call<OracleAccepted>({
          method: 'POST',
          path: '/oracle',
          headers: { 'X-Question-Id': params.questionId, 'X-Payment-Tx': params.paymentTx },
          body: {},
          retry: true,
          signal: options.signal,
        });
      } catch (err) {
        const notVisibleYet =
          err instanceof PaymentRequiredError &&
          /not yet visible/i.test(err.message) &&
          Date.now() < deadline;
        if (!notVisibleYet) throw err;
        await sleep(options.pollIntervalMs ?? 2_000, options.signal);
      }
    }
  }

  /**
   * Metered flow: charge the question against `payerAddress`'s prepaid
   * on-chain balance (funded once via the contract's `deposit()`), using a
   * session token from {@link authenticatePayer}. Throws
   * InsufficientBalanceError when the balance is too low. Not retried: a
   * lost response after the charge landed must not charge again.
   */
  async askMetered(question: string, params: AskOptions & { payerAddress: string; token: string }): Promise<OracleAccepted> {
    return this.call<OracleAccepted>({
      method: 'POST',
      path: '/oracle',
      body: {
        question,
        tier: params.tier,
        category: params.category,
        payerAddress: params.payerAddress,
        token: params.token,
      },
      retry: false,
    });
  }

  /** API-key flow: paid from the account's fiat credit. Needs `apiKey` on the client. Not retried. */
  async askWithApiKey(question: string, options: AskOptions = {}): Promise<OracleAccepted> {
    return this.call<OracleAccepted>({
      method: 'POST',
      path: '/oracle',
      body: { question, tier: options.tier, category: options.category },
      headers: { Authorization: `Bearer ${this.requireApiKey()}` },
      retry: false,
    });
  }

  /**
   * Picks the payment path from what you give it: the client's `apiKey`
   * if set, otherwise `payerAddress` + `token` (metered). For the classic
   * pay-per-call flow use {@link requestChallenge} + {@link submitPayment}.
   */
  async ask(question: string, options: AskOptions & { payerAddress?: string; token?: string } = {}): Promise<OracleAccepted> {
    if (this.apiKey) return this.askWithApiKey(question, options);
    if (options.payerAddress && options.token) {
      return this.askMetered(question, { ...options, payerAddress: options.payerAddress, token: options.token });
    }
    throw new TypeError(
      'ArbiterClient.ask: set apiKey on the client, or pass payerAddress + token — or use requestChallenge()/submitPayment() for pay-per-call',
    );
  }

  /** Sandbox: no payment, no chain. Returns a real job to poll, tagged `sandbox: true`. */
  async askSandbox(question: string, options: { tier?: TierKey; simulate?: SandboxSimulation } = {}): Promise<SandboxAccepted> {
    return this.call<SandboxAccepted>({
      method: 'POST',
      path: '/oracle/sandbox',
      body: { question, tier: options.tier, simulate: options.simulate },
      retry: false,
    });
  }

  // ------------------------------------------------------------------
  // Jobs
  // ------------------------------------------------------------------

  /** Current state of a job. Both 202 (in flight) and 200 (settled) are success. */
  async getJob(jobId: string, options: { signal?: AbortSignal } = {}): Promise<Job> {
    return this.call<Job>({ method: 'GET', path: `/oracle/${enc(jobId)}`, retry: true, signal: options.signal });
  }

  /** Polls until the job is `settled`, then returns it. Check `outcome` for resolved vs refunded. */
  async waitForResult(jobId: string, options: WaitOptions = {}): Promise<Job> {
    const timeoutMs = options.timeoutMs ?? 5 * 60_000;
    const deadline = Date.now() + timeoutMs;
    let last: Job | undefined;
    for (;;) {
      last = await this.getJob(jobId, { signal: options.signal });
      options.onUpdate?.(last);
      if (last.status === 'settled') return last;
      if (Date.now() + (options.intervalMs ?? 1_000) > deadline) {
        throw new JobTimeoutError(jobId, timeoutMs, last.status);
      }
      await sleep(options.intervalMs ?? 1_000, options.signal);
    }
  }

  /**
   * Cancels a paid question during its undo window (job status `holding`)
   * and refunds it. Authenticate with the payer's session `token`, or —
   * for a question asked with an API key — the client's `apiKey`. Throws
   * ConflictError once the window has closed.
   */
  async cancel(jobId: string, options: { token?: string } = {}): Promise<Job> {
    const useApiKey = !options.token && this.apiKey;
    return this.call<Job>({
      method: 'POST',
      path: `/oracle/${enc(jobId)}/cancel`,
      body: options.token ? { token: options.token } : {},
      headers: useApiKey ? { Authorization: `Bearer ${this.apiKey}` } : undefined,
      retry: false,
    });
  }

  // ------------------------------------------------------------------
  // Payer session — prove control of a Stellar address.
  // ------------------------------------------------------------------

  /** Returns a throwaway challenge transaction (never submitted) for `address` to sign. */
  async createPayerChallenge(address: string): Promise<{ xdr: string }> {
    return this.call({ method: 'POST', path: `/payers/${enc(address)}/session/challenge`, retry: true });
  }

  /** Exchanges the signed challenge for a session token. */
  async createPayerSession(address: string, signedXdr: string): Promise<Session> {
    return this.call({ method: 'POST', path: `/payers/${enc(address)}/session`, body: { signedXdr }, retry: false });
  }

  /** Challenge → sign → session in one call. */
  async authenticatePayer(address: string, signer: TransactionSigner): Promise<Session> {
    const { xdr } = await this.createPayerChallenge(address);
    const signedXdr = await signer(xdr, this.networkPassphrase);
    return this.createPayerSession(address, signedXdr);
  }

  // ------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------

  /** Prepaid balance. `token` is required for a real Stellar address. */
  async getPayerBalance(address: string, options: { token?: string } = {}): Promise<PayerBalance> {
    return this.call({ method: 'GET', path: `/payers/${enc(address)}/balance`, query: { token: options.token }, retry: true });
  }

  /** The payer's question history. `token` is required for a real Stellar address. */
  async getPayerQuestions(address: string, options: { token?: string } = {}): Promise<PayerQuestions> {
    return this.call({ method: 'GET', path: `/payers/${enc(address)}/questions`, query: { token: options.token }, retry: true });
  }

  async getWorkerOwed(address: string): Promise<WorkerOwed> {
    return this.call({ method: 'GET', path: `/workers/${enc(address)}/owed`, retry: true });
  }

  async getWorkerStake(address: string): Promise<WorkerStake> {
    return this.call({ method: 'GET', path: `/workers/${enc(address)}/stake`, retry: true });
  }

  async getWorkerReputation(address: string): Promise<WorkerReputation> {
    return this.call({ method: 'GET', path: `/workers/${enc(address)}/reputation`, retry: true });
  }

  /** Established workers ranked by match ratio. `limit` is capped at 200 by the server. */
  async getLeaderboard(options: { limit?: number } = {}): Promise<LeaderboardEntry[]> {
    const { leaderboard } = await this.call<{ leaderboard: LeaderboardEntry[] }>({
      method: 'GET',
      path: '/leaderboard',
      query: { limit: options.limit },
      retry: true,
    });
    return leaderboard;
  }

  async getStats(): Promise<Stats> {
    return this.call({ method: 'GET', path: '/stats', retry: true });
  }

  private requireApiKey(): string {
    if (!this.apiKey) throw new TypeError('ArbiterClient: this call needs the apiKey option');
    return this.apiKey;
  }
}
