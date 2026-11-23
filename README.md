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

## Try it locally

There is **no public hosted deployment yet**. Earlier revisions of this
README advertised `https://sandbox.arbiter.xyz` and
`https://demo.arbiter.xyz`; neither host is currently reachable, so they
are no longer documented as live targets. Do not point an integration at
them.

To try the backend, run it yourself (see
[`docs/local-full-stack.md`](docs/local-full-stack.md)):

```sh
npm install
npm start
```

That gives you a local instance on the port from `config.js` (default
`3000`), serving the app from `app/dist` unless `SERVE_STATIC_APP=false`.

### Zero-chain mode (`POST /oracle/sandbox`)

`/oracle/sandbox` (`backend/src/sandbox.js`) is a purely local simulation.
Its own docstring says it "Never touches stellarClient.js — no chain
calls," which is exactly why it's zero-setup, but also why it can't prove
anything about real Soroban RPC latency, real surge pricing, or a real
`submit()`/`resolve()`/`withdraw()` round trip. It returns canned response
shapes with no payment and no chain. Use it to see a response shape before
setting up a wallet.

### Funding a testnet USDC path

You do not need Arbiter's own platform key to get test funds. To fund your
own integration against a locally run instance:

1. Create and fund a testnet Stellar account with Friendbot:
   `curl "https://friendbot.stellar.org?addr=<YOUR_TESTNET_ADDRESS>"`.
2. Add a trustline for the testnet USDC asset issued by the deployment you
   are running (see its `/health` response and the
   `arbiter-contract` testnet deployment notes for the current issuer and
   asset code).
3. Acquire testnet USDC from a documented testnet faucet, or
   from any testnet DEX path against that issuer, and pay for questions
   from your own key.

This keeps your integration independent of Arbiter's platform key and of
any single hot key's funding.

## Teams and member roles

Team/organization accounts (`teams.js`) are a named group of Stellar
addresses that can see each other's question history and spend in one
place. A team adds no new credential: it is a membership list over
existing identities, so every member keeps paying from, and owning, their
own address. Roles, strongest first:

- **owner** — exactly one per team. Everything an admin can do, plus
  promoting/demoting admins, transferring ownership, and deleting the
  team. Can't leave or be removed without first transferring ownership, so
  a team is never ownerless.
- **admin** — add and remove plain members, rename the team.
- **member** — read the team and its combined question history; leave.

## Static frontend hosting (`SERVE_STATIC_APP`)

By default the backend also serves the built worker-console/dashboard/
leaderboard SPA from `app/dist` via `express.static`, which is what makes
`npm start`-style local and single-process demo runs work out of the box.

In production the app build is deployed separately and fronted by a static
host, so the backend does not need to serve those assets at all. Set `SERVE_STATIC_APP=false` to skip mounting the
`express.static` middleware entirely — static-asset requests then fall
through to the normal 404 handler instead of being served by the same
process that handles latency-sensitive settlement traffic. Leave it unset
(or `true`) for local dev and small single-process deployments where the
backend is the only thing serving the app.

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
  revenue, and fraud/trust monitoring. Its list/summary reads can go to a
  Redis read replica (`REDIS_REPLICA_URL`, `replicaStore.js`) so an operator
  browsing the console never competes with settlement for the primary; a
  failing replica falls back to the primary, and `GET /admin/read-replica`
  reports which one is in use and the replica's lag.
- **Payer referrals (`payerReferrals.js`)** — a payer who passes a worker's
  referral code (`body.referralCode` on `POST /oracle`) on their first
  verified payment is attributed to that worker, once and permanently, with
  an informational credit (`PAYER_REFERRAL_REWARD_BPS` of that payment)
  listed at `GET /admin/referral-earnings`. Bookkeeping only: nothing is
  paid out.
- **Canary deployments ([docs/runbooks/canary-deployment.md](docs/runbooks/canary-deployment.md))** —
  `INSTANCE_ROLE=canary` serves read-only traffic and never signs as the
  platform key; a fleet-wide signer lock stops two instances racing the
  platform account's sequence number; SIGTERM drains in-flight questions
  before exit; `npm run canary:preflight` checks a canary matches the primary.
- Every environment variable the code reads is documented in
  [`.env.example`](.env.example); `npm run check:env` (run in CI) fails on drift.
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

Instead of polling `GET /oracle/:jobId`, a payer can register a webhook
endpoint and receive a signed delivery when a question settles. Deliveries
are retried with bounded backoff and are idempotent per job id, so a
receiver can safely treat a repeated delivery as the same event.

## Running it locally

Install dependencies, copy `.env.example` to `.env`, and start the server:

```sh
npm install
cp .env.example .env
npm start
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

## Referrals and onboarding

A worker gets a referral code (`ARB-XXXXXXXX`) from
`POST /workers/:address/referral-code` with `{ token }`, and tracks each
referee's progress at `GET /workers/:address/referrals?token=...`. A referee
is `pending` until established, then `qualified`. They become `disqualified`
if their match ratio is under the routing gate, or if collusion detection
flags them together with their referrer. Codes are tracked only by this
backend. There's no on-chain referral payout.

A new worker onboards with one call. They get a session token for the new
address (the challenge is signed offline, so the account doesn't need to
exist yet), then call `POST /workers/:address/onboard` with
`{ token, referralCode }`. This redeems the code and returns the sponsored
account + USDC trustline transaction. The worker signs it and submits it to
`POST /sponsor/onboard/submit`. `GET /referrals/:code` checks a code before
the worker signs anything.

Each address can redeem one code, and only before it has any answer history.
Self-referral is rejected, and each code has a use cap
(`REFERRAL_MAX_USES_PER_CODE`). Set `REFERRAL_REQUIRED_FOR_SPONSORED_ONBOARDING=true`
to require a referral code for sponsored onboarding.

## Collusion detection

`collusion.js` scores pairs of workers across the quorums they share. It
combines five signals with a weighted noisy-OR:

- identical wrong answers
- agreement above what their individual match ratios predict
- answers submitted within `COLLUSION_SYNC_WINDOW_MS` of each other
- a referral link between them
- a shared connection IP (stored only as an HMAC)

When a pair's score reaches `COLLUSION_FLAG_SCORE`, the pair is flagged. Any
quorum where a flagged pair gives the same answer skips the reconcile fast
path and goes to review. When a pair's score reaches `COLLUSION_SUSPEND_SCORE`,
both workers are also dropped from routing. Like the other routing gates, this
one fails open. Operators review pairs at `GET /admin/collusion` and
`GET /admin/collusion/workers/:workerId`, and clear them with
`POST /admin/collusion/clear`. After a pair is cleared, only a worse score
suspends it again. These are heuristics: nothing here slashes stake.

## Teams and member roles

A team is a named group of Stellar addresses that share one view of their
question history and spend. It adds no new credential: every call
authenticates as a member with `address` plus a session `token` from
`POST /payers/:address/session`, in the JSON body or the query string.

```http
POST   /teams                                {"name": "Acme research"}
GET    /teams                                teams you belong to
GET    /teams/:teamId
PATCH  /teams/:teamId                        {"name": "..."}            (admin)
DELETE /teams/:teamId                                                   (owner)
POST   /teams/:teamId/members                {"members": ["G..."], "role": "member"}
PATCH  /teams/:teamId/members/:member        {"role": "admin"}          (owner)
DELETE /teams/:teamId/members/:member        remove a member, or leave
GET    /teams/:teamId/questions              combined history + spendByMember
```

Each team has exactly one `owner`, plus any number of `admin`s and
`member`s. Admins add and remove plain members. Only the owner manages
admins. Setting another member's role to `owner` transfers ownership, and
the previous owner becomes an admin. The owner can't leave or be removed
until ownership is transferred. People who aren't members get a `404` for a
team. Limits: 100 members per team, 20 teams per address.

## Maintenance windows

Operators can pause dispatch for holidays or planned maintenance:

```http
POST   /admin/maintenance-windows   {"startsAt": "2026-12-24T00:00:00Z", "endsAt": "2026-12-27T00:00:00Z", "reason": "holiday"}
GET    /admin/maintenance-windows
DELETE /admin/maintenance-windows/:id    (deleting an active window ends the pause now)
GET    /maintenance                      public: current pause + upcoming windows
```

While a window is active, requests to `POST /oracle` that would create a
question get `503` with `Retry-After` and `resumesAt`, before anyone is
charged. Questions aren't queued through a pause, because the contract's
`refund_timeout()` would make a paid question refundable long before a
holiday ends. So a question that was already paid for when the window opened
is refunded (`reconciliationMethod: "dispatch-paused"`) instead of being
dispatched. This covers step 2 of the classic flow and jobs still in their
undo-window hold. Questions that were already dispatched finish normally.
Sandbox requests are unaffected. Windows that overlap or touch are merged
into a single pause.

## Dependency updates

`.github/dependabot.yml` runs a weekly npm update job. Minor and patch bumps
are grouped into one PR, and each major bump gets its own. It's scoped to
the repo root (`/`) because this split-out repo carries a single npm package.
Nothing is auto-merged: these PRs need human review.

## Load testing and capacity

Load-test tooling (`scripts/loadtest.js`), measured limits, and the current
bottleneck (serialized on-chain settlement) are in
[docs/capacity/README.md](docs/capacity/README.md).

## Handsoff notes
`GET /health` should then answer, and `POST /oracle/sandbox` gives a
zero-payment, zero-chain response shape without any wallet or chain setup.
See [docs/local-full-stack.md](docs/local-full-stack.md) for the full
local stack (Redis, worker console, and the app build).

<!-- handsoff-issue-108 -->
- #108: A public status page reporting real uptime/incident history

<!-- handsoff-issue-84 -->
- #84: Multi-tenant white-label backend

## Handsoff notes

<!-- handsoff-issue-241 -->
- #241: All three billing processors call an undefined resolveCurrency()/SUPPORTED_CURRENCIES

<!-- handsoff-issue-541 -->
- #541: Add tests for admin.getTreasury
