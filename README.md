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

## Running it

```sh
npm install
npm test              # no chain needed
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

### Running the full stack locally

To run the contract, this backend, and the app together (deploy the
contract to testnet, point this backend at it, point the app at this
backend, then run a real paid question end to end), see
**[docs/local-full-stack.md](docs/local-full-stack.md)**. It's the single
cross-repo guide, and it pins contract/app versions known to work with this
backend.

### Capacity

Load-test tooling (`scripts/loadtest.js`), measured limits, and the current
bottleneck (serialized on-chain settlement) are in
[docs/capacity/README.md](docs/capacity/README.md).
