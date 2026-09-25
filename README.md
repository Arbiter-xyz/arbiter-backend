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

- **Escalating quorum (`auto` tier)** — asks one worker first and recruits
  more only when that answer isn't confident enough. The confidence signal
  for a lone answer is the worker's own reputation (Laplace-smoothed match
  ratio, zero for unestablished workers — see `singleAnswerConfidence` in
  `dispatch.js` for why not a vote or an LLM check), and the settle/escalate
  decision is a pure function (`decideEscalation`). The final size isn't
  known at quote time, so it is quoted and charged at the ceiling (the
  full-cap price). The real recruited count and effective price are stored on
  the job (`recruitedWorkers`, `quorumSizeUsed`, `effectiveAmountStroops`).
  On the prepaid/API-key path the unused portion is refunded to the
  customer's credit; on the on-chain `submit()` path the escrow can't shrink,
  so the platform keeps the difference (same as the surge-price ceiling).
  The fixed tiers are unchanged.
- **Security headers** — every response carries a same-origin-only
  `Content-Security-Policy` (no inline/eval script, no framing, no plugins),
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy` and `Strict-Transport-Security`
  (`securityHeaders.js`). If the UI is hosted on another origin, list it in
  `CSP_CONNECT_SRC`; `HSTS_ENABLED=false` turns HSTS off.
- **MCP server** — [`mcp-server/`](mcp-server/README.md) exposes Arbiter as
  agent-callable tools (`@arbiter-xyz/mcp-server`).

## Running it

```sh
npm install
npm test              # 166 tests, no chain needed
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

## Handsoff notes

<!-- handsoff-issue-4 -->
- #4: Graceful drain for in-flight SSE quorum-collection windows on deploy/restart
