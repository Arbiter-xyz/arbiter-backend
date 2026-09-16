# arbiter-backend

The Express/Node backend for **Arbiter**, a pay-per-question
human-intelligence oracle settled on Stellar/Soroban. Terminates the HTTP
402 payment flow, dispatches questions to workers over SSE, reconciles
answers, and settles on-chain against
[arbiter-contract](https://github.com/Arbiter-xyz/arbiter-contract). It's
the sole holder of the platform's admin key — the only component allowed
to call `resolve()`/`refund()`/`touch()` — and, separately, the pooled
fiat-onramp float key (kept deliberately distinct; see "Billing" below).

Split out of the original `arbiter` monorepo and kept in sync with it as
development continues — full history and the round-by-round build
narrative live in the original
[`arbiter`](https://github.com/rudeus112266/arbiter) repo; this repo tracks
its `backend/` subtree.

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

## Running it

```sh
npm install
npm test              # 166 tests, no chain needed
cp .env.example .env  # fill in ORACLE_CONTRACT_ID / PLATFORM_SECRET for real use
npm start
```

Verified live against a real deployed contract on Stellar testnet — a full
paid question (payment → dispatch → reconcile → `resolve()`) and a real
sponsored `withdraw()` landing real USDC in a zero-XLM wallet. See the
original monorepo's README, "Round 6," for the full writeup including two
real bugs that live infrastructure surfaced and mocked tests never could.
