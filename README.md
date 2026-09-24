# arbiter-backend

The Express/Node backend for **Arbiter**, a pay-per-question
human-intelligence oracle settled on Stellar/Soroban. Terminates the HTTP
402 payment flow, dispatches questions to workers over SSE, reconciles
answers, and settles on-chain against
[arbiter-contract](https://github.com/Arbiter-xyz/arbiter-contract). It's
the sole holder of the platform's admin key — the only component allowed
to call `resolve()`/`refund()`/`touch()` — and, separately, the pooled
fiat-onramp float key (kept deliberately distinct; see "Billing" below).

Originally split out of a monorepo; that monorepo is now retired — this
repo is the sole source of truth for the backend's code going forward,
version-pinned against `arbiter-contract`'s releases rather than kept in
lockstep by hand (see #163). Pre-split history and the round-by-round
build narrative live in the archived
[`arbiter`](https://github.com/rudeus112266/arbiter) repo.

## What it does

- Async job-based `/oracle` — `202` immediately once payment is confirmed,
  clients poll `GET /oracle/:jobId` rather than holding a connection open.
  Three payment methods on the one endpoint: classic pay-per-call
  `submit()`, a prepaid on-chain balance for a wallet-holding payer, or an
  `Authorization: Bearer` API key for a payer with no wallet at all (see
  Billing below) — chosen transparently by what the caller sends.
- `POST /oracle/sandbox` — a zero-payment, zero-chain, zero-LLM sandbox
  endpoint so an integrator can see a real response shape before setting
  up a wallet.
- Live surge pricing, worker category routing, staking/reputation-gated
  reconciliation fast path (with an on-chain stake-gate opt-in for
  dispatch eligibility), Web Push for offline workers, structured (pino)
  logging with request/job correlation, idempotent job creation, and
  bounded retry/timeout on every external call (Claude, Soroban RPC,
  Horizon).
- Cryptographic worker session auth (`workerAuth.js`) — an address-format
  `workerId` must prove control of that key before submitting an answer.
- A read-only admin/ops console (`/admin/*`, bearer-token gated) —
  transactions, workers, payers, live on-chain treasury balance, fee
  revenue, and fraud/trust monitoring.
- A SEP-24/SEP-12 fiat anchor client (`anchorClient.js`) — Arbiter never
  holds PII or bank details itself, only resolves and caches the
  configured anchor's public `stellar.toml` for the frontend.
- **Billing (`billing.js`)** — the non-crypto onramp: a customer pays via
  Stripe Checkout and is issued an API key instead of ever touching a
  Stellar wallet. Every fiat-paid question still settles on-chain, from
  one pooled balance under a dedicated fiat-pool key, through the exact
  same `chargeBalance()` path the wallet-based prepaid flow already uses.
  Credit reservations are atomic and webhook delivery is idempotent per
  Stripe event id.

## Webhooks

Instead of polling `GET /oracle/:jobId`, a payer or API-key customer can
register a URL that receives a signed `POST` whenever one of their
questions settles, whether it's resolved or refunded.

**Register, list, delete.** Authenticate as either:
- an API-key customer: `Authorization: Bearer ak_live_...`, or
- a wallet payer: `address` plus a session `token` from
  `POST /payers/:address/session`, sent in the JSON body or the query string.

```http
POST   /webhooks        {"url": "https://example.com/arbiter", "description": "prod"}
GET    /webhooks
DELETE /webhooks/:id
```

The `201` response to `POST /webhooks` includes the registration's signing
secret (`whsec_...`). It is shown **only once**, the same convention as API
keys. Targets must be `https` and publicly reachable. localhost-style names
and private, loopback, link-local or reserved addresses are rejected at
registration, and checked again against the resolved IP at delivery time
(SSRF / DNS-rebinding guard). Each owner can register up to
`WEBHOOK_MAX_PER_OWNER` URLs.

**Each delivery** is a JSON `POST` with these headers:

```
X-Arbiter-Event: question.settled
X-Arbiter-Event-Id: evt_...          (identical across retries: dedupe on it)
X-Arbiter-Webhook-Id: wh_...
X-Arbiter-Delivery-Attempt: 1..N
X-Arbiter-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
```

The body is `{ id, type: "question.settled", createdAt, data: { jobId, ... } }`.
`data` has the same shape as `GET /oracle/:jobId`.

**Verifying a delivery.** Compute
`HMAC-SHA256(key = your whsec_ secret, message = t + "." + raw_request_body)`,
hex-encode it, and compare it to `v1` in constant time. Use the raw body
bytes exactly as received, before parsing the JSON. Reject a `t` that is
more than about 5 minutes old. For example, in Node:

```js
const [, t, v1] = /t=(\d+),v1=([0-9a-f]+)/.exec(req.get('X-Arbiter-Signature'));
const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expected, 'hex'))
  && Math.abs(Date.now() / 1000 - Number(t)) < 300;
```

**Retries.** Any non-2xx response (redirects are not followed), timeout or
network error is retried with exponential backoff: 5s, 10s, 20s and so on,
up to `WEBHOOK_MAX_ATTEMPTS` attempts in total. After that, delivery is
abandoned and the failure is logged. A `410 Gone` response deactivates the
registration. `GET /webhooks` shows each registration's last delivery status.
Delivery never blocks or affects settlement, and `GET /oracle/:jobId` stays
the source of truth.

## Spend breakdowns

Every job record carries the question's `category`, and `GET /oracle/:jobId`
and `GET /admin/transactions` return it. `GET /payers/:address/questions`
also returns `spendByCategory` and `spendByDay` (UTC days) buckets for spend
dashboards.

## Dependency updates

`.github/dependabot.yml` runs a weekly npm update job. Minor and patch bumps
are grouped into one PR, and each major bump gets its own. It's scoped to
the repo root (`/`) because this split-out repo carries a single npm package.
Nothing is auto-merged: these PRs need human review.

## Running it

```sh
npm install
npm test              # 230 tests, no chain needed
cp .env.example .env  # fill in ORACLE_CONTRACT_ID / PLATFORM_SECRET for real use
npm start
```

Verified live against a real deployed contract on Stellar testnet — a full
paid question (payment → dispatch → reconcile → `resolve()`) and a real
sponsored `withdraw()` landing real USDC in a zero-XLM wallet. (That run
predates this repo's split; see "Round 6" in the archived
[`arbiter`](https://github.com/rudeus112266/arbiter) monorepo README for
the full write-up, including two real bugs that live infrastructure
surfaced and mocked tests never could.)
