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

## Try it live

Two public deployments exist, and they are deliberately different things:

| Environment | URL | Lifetime | Chain calls |
| --- | --- | --- | --- |
| **Developer sandbox** | `https://sandbox.arbiter.xyz` | Long-lived; kept up for integrators | Real Soroban testnet `submit()`/`resolve()`/`withdraw()` round trips |
| **Demo deployment** | `https://demo.arbiter.xyz` | Disposable; may be redeployed or torn down after the SCF submission window | Real Soroban testnet, but not a stable target |

### Developer sandbox (`https://sandbox.arbiter.xyz`)

This is the environment to point a real integration at. It runs its own
Soroban testnet contract deployment with its own `contractId` and
`PLATFORM_SECRET`, kept distinct from whatever gets redeployed for demo
purposes, and its own backend service and `config.js` env block. It is
committed to staying up rather than being torn down after a submission
window, and it reuses the existing `rateLimit.js` / `config.rateLimits`
machinery at a more generous ceiling than the demo deployment, since it
absorbs sustained integrator traffic rather than one-off demo hits.

`GET /health` and a real `/oracle` submit→resolve round trip are expected
to succeed against it in checks run at least a week apart. "Long-lived"
means "not torn down after a specific date" — it is not an uptime SLA.

### Demo deployment (`https://demo.arbiter.xyz`)

The public Railway/Vercel deployment referenced in earlier revisions of
this README. It is a disposable testnet deployment on free-tier hosting:
expect it to be redeployed or torn down after the SCF submission window,
not a permanent production environment. Use it to look around, not to
build against.

### Zero-chain mode (`POST /oracle/sandbox`)

Distinct from both of the above: `/oracle/sandbox` (`backend/src/sandbox.js`)
is a purely local simulation. Its own docstring says it "Never touches
stellarClient.js — no chain calls," which is exactly why it's zero-setup,
but also why it can't prove anything about real Soroban RPC latency, real
surge pricing, or a real `submit()`/`resolve()`/`withdraw()` round trip.
It returns canned response shapes with no payment and no chain. Use it to
see a response shape before setting up a wallet; use the developer
sandbox when you need the real round trip.

### Funding a testnet USDC path

You do not need Arbiter's own platform key to get test funds. To fund your
own integration against the developer sandbox:

1. Create and fund a testnet Stellar account with Friendbot:
   `curl "https://friendbot.stellar.org?addr=<YOUR_TESTNET_ADDRESS>"`.
2. Add a trustline for the testnet USDC asset issued by the sandbox's
documented testnet issuer (see the sandbox's `/health` response and the
`arbiter-contract` testnet deployment notes for the current issuer and
asset code).
3. Acquire testnet USDC from the sandbox's documented testnet faucet, or
   from any testnet DEX path against that issuer, and pay for questions
   from your own key.

This keeps your integration independent of Arbiter's platform key and of
any single hot key's funding.

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
- **Private worker pools** (`privatePools.js`) — a payer can whitelist
  worker addresses (`GET`/`POST /payers/:address/pool`,
  `DELETE /payers/:address/pool/:worker`, session-token gated). Their
  questions then go only to, and only take answers from, those workers.
  This **fails closed**: if no whitelisted worker is online, the question
  is refunded rather than sent to the open pool. Payers without a pool
  are unaffected.
- **Configurable consensus rules** (`consensus.js`) — `consensusMode:
  'numeric-tolerance'` with `tolerance: { percent }` or `{ absolute }` on
  `POST /oracle` makes numeric answers ("42", "$42.00", "about 42") within
  tolerance count as agreeing, without a Claude call. The default `'exact'`
  mode is unchanged. The rule used is shown on `GET /oracle/:jobId`.
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
- **Answer provenance ([docs/provenance.md](docs/provenance.md))**: every
  settled question commits (sha256 over canonical JSON) to its raw worker
  submissions and any LLM prompt/response before `resolve()`/`refund()`
  is sent. The record is public at `GET /oracle/:jobId/provenance`, and
  `scripts/verify-provenance.js` lets anyone re-derive the consensus and
  check it against the on-chain payout.
- **Startup security-posture check (`securityPosture.js`)**: a deployment
  that looks like production refuses to start without `SESSION_SECRET`,
  and logs a loud error for wide-open `ALLOWED_ORIGINS` or a non-TLS
  `REDIS_URL`. Local dev with every default left alone stays silent.

## Client SDKs

First-party clients for the agent-facing API (ask → pay → poll, payer
session auth, the undo window, and the public reads), each with its own
README, tests, and changelog:

- **TypeScript / JavaScript**: [`sdk/typescript`](sdk/typescript) (`@arbiter-xyz/sdk`), for Node 18+ and browsers
- **Python**: [`sdk/python`](sdk/python) (`arbiter-sdk`), for Python 3.9+

Both can be tried against `POST /oracle/sandbox` with no wallet at all,
and against the developer sandbox for a real round trip.

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

## Running i

/* … truncated 1211 chars — edit only what you need near the top … */
