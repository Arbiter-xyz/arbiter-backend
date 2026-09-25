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

## Client SDKs

First-party clients for the agent-facing API (ask → pay → poll, payer
session auth, the undo window, and the public reads), each with its own
README, tests, and changelog:

- **TypeScript / JavaScript**: [`sdk/typescript`](sdk/typescript) (`@arbiter-xyz/sdk`), for Node 18+ and browsers
- **Python**: [`sdk/python`](sdk/python) (`arbiter-sdk`), for Python 3.9+

Both can be tried against `POST /oracle/sandbox` with no wallet at all.

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

## Mainnet cutover runbook

This is the single, proven procedure for cutting Arbiter over to mainnet.
It covers contract deploy, backend config, and key custody handoff, and it
has been dry-run end-to-end against testnet — including an intentionally
failed step to prove rollback works. Steps that touch the contract are
owned jointly with
[`arbiter-contract`](https://github.com/Arbiter-xyz/arbiter-contract);
coordinate the deploy/upgrade steps there before running them here.

Each step lists a **sign-off** — the concrete evidence that proves the step
succeeded before the next one starts. Do not advance on a step whose
sign-off is unmet; instead invoke the rollback for that step (see
"Rollback" below).

### Phase 0 — Preconditions

1. **Freeze and tag.** Freeze `main` on this repo and on `arbiter-contract`;
   record the exact commit SHAs and the `arbiter-contract` release tag this
   backend is version-pinned to (#163).
   - *Sign-off:* both SHAs recorded in the cutover ticket; CI green on both
     frozen commits.
2. **Rehearse on testnet.** Run this entire runbook against testnet first
   (see "Dry run" below). No mainnet step runs until the testnet dry run,
   including its forced-failure rollback, has passed.
   - *Sign-off:* completed dry-run log attached to the cutover ticket.

### Phase 1 — Contract deploy (`arbiter-contract`)

3. **Deploy the contract** to mainnet from the frozen `arbiter-contract`
   tag, using the contract repo's own deploy procedure.
   - *Sign-off:* contract ID returned and recorded; `arbiter-contract`'s
     post-deploy verification passes.
4. **Initialize and verify on-chain state** — admin key set to the platform
   admin address, fee/treasury config set, and a read-only smoke call
   (`touch()` or equivalent) succeeds against the deployed ID.
   - *Sign-off:* on-chain admin address matches the intended custody
     address; smoke call returns success; state visible via Soroban RPC.

### Phase 2 — Backend config

5. **Point the backend at mainnet.** Set `ORACLE_CONTRACT_ID` to the new
   mainnet contract ID, set the mainnet Soroban RPC / Horizon endpoints,
   and confirm `PLATFORM_SECRET` resolves to the admin key from step 4.
   - *Sign-off:* a staging instance boots with the mainnet config and
     `GET /admin/*` reports the expected contract ID and a live treasury
     balance read from mainnet.
6. **Verify the payment path.** Run one real, low-value paid question
   end-to-end on mainnet (payment → dispatch → reconcile → `resolve()`),
   and confirm fee sponsorship costs match the estimate from the dry run.
   - *Sign-off:* the question reaches a settled `resolve()` on mainnet and
     the observed sponsorship cost is within the dry-run estimate.
7. **Cut over DNS/infra.** Flip the public DNS/ingress to the mainnet
   backend instance and confirm TLS.
   - *Sign-off:* the public hostname serves the mainnet instance; TLS
     valid; a sandbox call (`POST /oracle/sandbox`) succeeds through the
     public hostname.

### Phase 3 — Key custody handoff

8. **Hand off the admin key.** Transfer custody of the platform admin key
   from the deployer to the production custody holder (HSM/KMS or the
   agreed multi-party holder), and rotate the fiat-pool key separately.
   The two keys stay distinct (see "Billing").
   - *Sign-off:* the production custody holder signs a test `resolve()`
     (or equivalent admin call) on mainnet; the deployer's copy is
     revoked; the fiat-pool key is confirmed distinct from the admin key.
9. **Confirm the backend uses the handed-off key.** Restart the backend
   against the production custody source and re-run the step-6 smoke.
   - *Sign-off:* a fresh paid question settles using the handed-off key;
     no reference to the deployer's key remains in config or env.

### Phase 4 — Close-out

10. **Announce and monitor.** Enable production alerting on treasury
    balance, settlement failures, and sponsorship spend; announce the
    cutover.
    - *Sign-off:* alerting fires on a synthetic failure; first production
      question settles; cutover ticket closed with all sign-offs attached.

### Rollback

Rollback is per-step and must be rehearsed, not improvised. The general
rule: **if step N's sign-off is unmet, revert to the last step whose
sign-off passed, then re-run forward.**

- **Steps 3–4 (contract):** redeploy the previous `arbiter-contract`
  release and re-point `ORACLE_CONTRACT_ID` at the prior contract ID.
- **Steps 5–7 (backend/infra):** restore the previous backend config
  (prior contract ID, prior RPC/Horizon endpoints) and flip DNS/ingress
  back to the pre-cutover instance.
- **Steps 8–9 (custody):** re-establish the deployer's key as the active
  admin key and re-run the step-4 verification; do not leave custody in a
  half-transferred state.

### Dry run (testnet)

The full runbook above was executed against testnet, exercising every step
with the mainnet-specific differences simulated: real fee-sponsorship
costs were measured (not mocked), the key custody handoff was performed
between two distinct key holders, and DNS/ingress was cut over to a
staging hostname.

To prove rollback actually works, **step 6 was intentionally failed**: the
payment path was pointed at a deliberately wrong contract ID so the
settlement could not complete. The runbook's rollback was then invoked —
config restored to the last passing step (step 5), the backend restarted,
and the payment path re-run successfully. The dry run only counts as
passed once this forced-failure rollback has been demonstrated, not just
the happy path.

- *Dry-run sign-off:* every step's sign-off met on testnet, plus a logged
  forced failure at step 6 followed by a clean rollback and a successful
  re-run.
