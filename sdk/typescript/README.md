# @arbiter-xyz/sdk

TypeScript client for the [Arbiter](https://github.com/Arbiter-xyz/arbiter-backend) API: ask a question, pay for it, and poll for a human-verified answer. Typed request/response models throughout, zero runtime dependencies, works in Node 18+ and browsers.

```sh
npm install @arbiter-xyz/sdk
# only if you want keypairSigner() for Node-side session auth:
npm install @stellar/stellar-sdk
```

## Try it without a wallet (sandbox)

`POST /oracle/sandbox` needs no payment, chain, or key, and returns a real job with the same shape as a paid one:

```ts
import { ArbiterClient } from '@arbiter-xyz/sdk';

const arbiter = new ArbiterClient({ baseUrl: 'http://localhost:4000' });

const { jobId } = await arbiter.askSandbox('Is the Third Mainland Bridge open right now?');
const job = await arbiter.waitForResult(jobId, { onUpdate: (j) => console.log(j.status) });

console.log(job.outcome, job.answer, job.confidence);
```

A runnable copy is in [`examples/sandbox.ts`](examples/sandbox.ts) (`ARBITER_URL=http://localhost:4000 npm run example:sandbox`). Use `simulate: 'disagreement' | 'no-answers'` to exercise the refund shapes.

## Asking a real question

`POST /oracle` supports three ways to pay. Each returns `202` with a `jobId`; poll `waitForResult(jobId)` until `status === 'settled'`, then read `outcome` (`resolved` means `answer` is set; `refunded` or `refund_pending_timeout` means you weren't charged).

### 1. API key (no wallet)

Paid from credit bought via Stripe (`POST /billing/checkout`).

```ts
const arbiter = new ArbiterClient({ baseUrl, apiKey: 'ak_live_...' });
const { jobId } = await arbiter.askWithApiKey('Is this invoice a duplicate?', { tier: 'express' });
const job = await arbiter.waitForResult(jobId);
```

### 2. Prepaid balance (payer address + session token)

Fund once by calling the contract's `deposit()` yourself. After that, prove you control the payer address once per session, and ask with no per-question signing:

```ts
import { keypairSigner } from '@arbiter-xyz/sdk/stellar'; // Node; in a browser pass your wallet's signTransaction

const session = await arbiter.authenticatePayer(payerAddress, keypairSigner(process.env.PAYER_SECRET!));

const { jobId } = await arbiter.askMetered('What does this sign say?', {
  payerAddress,
  token: session.token,
  tier: 'standard',
});
```

`authenticatePayer` fetches a throwaway challenge transaction, has your signer sign it (it's never submitted), and exchanges it for a session token. A `TransactionSigner` is just `(xdr, networkPassphrase) => signedXdr | Promise<signedXdr>`, so any wallet adapter fits. Set `networkPassphrase` on the client for mainnet (`PUBLIC_PASSPHRASE`).

### 3. Pay per call (the 402 flow)

```ts
const challenge = await arbiter.requestChallenge('Is the venue wheelchair accessible?', {
  tier: 'priority',
  idempotencyKey: crypto.randomUUID(), // safe retries: same key → same questionId
});

// Pay on-chain yourself: submit(payer, challenge.questionId, challenge.amountStroops)
// on challenge.contractId, then hand the backend the transaction hash.
const { jobId } = await arbiter.submitPayment({ questionId: challenge.questionId, paymentTx: txHash });
const job = await arbiter.waitForResult(jobId);
```

`submitPayment` keeps re-checking for up to 30s (`waitForPaymentMs`) while the backend reports the payment as "not yet visible on-chain", because RPC nodes can lag a few seconds behind a successful transaction.

`ask(question, options)` picks the API-key or metered path automatically based on what you pass it.

### Undo window

Paid non-instant questions are held for a few seconds (`status: 'holding'`, until `cancellableUntil`) before workers see them. During that window:

```ts
await arbiter.cancel(jobId, { token: session.token }); // or no token → uses the client's apiKey
```

After the window closes, `cancel` throws `ConflictError`.

## Other endpoints

| Method | Endpoint |
| --- | --- |
| `getJob(jobId)` | `GET /oracle/:jobId` |
| `getPayerBalance(address, { token })` | `GET /payers/:address/balance` |
| `getPayerQuestions(address, { token })` | `GET /payers/:address/questions` |
| `getWorkerOwed(address)` | `GET /workers/:address/owed` |
| `getWorkerStake(address)` | `GET /workers/:address/stake` |
| `getWorkerReputation(address)` | `GET /workers/:address/reputation` |
| `getLeaderboard({ limit })` | `GET /leaderboard` |
| `getStats()` | `GET /stats` |
| `createPayerChallenge` / `createPayerSession` | the two halves of `authenticatePayer` |

Amounts come back as both `amount` (decimal USDC string, 7 places) and `amountStroops` (integer string; 1 USDC = 10,000,000 stroops). Timestamps are epoch milliseconds.

## Errors, retries, timeouts

Non-2xx responses throw an `ArbiterError` (`.status`, `.body`) or one of its subclasses:

| Class | When |
| --- | --- |
| `PaymentRequiredError` | 402: unpaid, underpaid, or out of API credit |
| `InsufficientBalanceError` | 402 on the metered path; `.instructions` explains how to `deposit()` |
| `AuthenticationError` | 401: bad or expired session token or API key |
| `RateLimitedError` | 429 (`.retryAfterMs` when the server sends `Retry-After`) |
| `NotFoundError` / `ConflictError` | 404 unknown job / 409 e.g. cancel after the undo window |
| `ArbiterNetworkError` | no response: network failure or client timeout |
| `JobTimeoutError` | `waitForResult` gave up; the job may still settle later |

Each attempt times out after `timeoutMs` (default 15s). Requests that are safe to repeat (every GET, session calls, `submitPayment`, and `requestChallenge` with an `idempotencyKey`) are retried up to `maxRetries` (default 2) on network errors, 408/425/429, and 5xx, with exponential backoff. `askMetered`, `askWithApiKey`, `askSandbox`, and `cancel` are **never** retried automatically: if a response is lost after the charge landed, a retry would charge you twice. Check `getPayerQuestions` or retry deliberately.

## Runtime support

The core client uses only `fetch`, `URL`, and `AbortController`, so it runs in Node 18+, Deno, Bun, and browsers. Pass `fetch` in the options to use a custom implementation. `@arbiter-xyz/sdk/stellar` (`keypairSigner`) needs the optional peer dependency `@stellar/stellar-sdk`. In a browser, use your wallet's signer instead of handling secret keys.

## Development

```sh
npm install
npm test          # mocked-HTTP test suite (Node ≥ 22.6, uses built-in type stripping)
npm run typecheck
npm run build     # → dist/ (ESM + .d.ts)
```

### Publishing

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. `npm publish --access public`. This needs publish rights on the `@arbiter-xyz` npm scope, and `prepublishOnly` runs typecheck, tests, and build first.
