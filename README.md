# arbiter-backend

The Express/Node backend for **Arbiter**, a pay-per-question
human-intelligence oracle settled on Stellar/Soroban. Terminates the HTTP
402 payment flow, dispatches questions to workers over SSE, reconciles
answers, and settles on-chain against
[arbiter-contract](https://github.com/Arbiter-xyz/arbiter-contract). It's
the sole holder of the platform's admin key — the only component allowed
to call `resolve()`/`refund()`.

Split out of the original `arbiter` monorepo. Fresh single commit, not a
history-preserving split — full history and the six-round build narrative
live in the original [`arbiter`](https://github.com/rudeus112266/arbiter)
repo.

## What it does

- Async job-based `/oracle` — `202` immediately once payment is confirmed,
  clients poll `GET /oracle/:jobId` rather than holding a connection open.
- `POST /oracle/sandbox` — a zero-payment, zero-chain, zero-LLM sandbox
  endpoint so an integrator can see a real response shape before setting
  up a wallet.
- Live surge pricing, worker category routing, staking/reputation-gated
  reconciliation fast path, Web Push for offline workers, structured
  (pino) logging with request/job correlation, idempotent job creation,
  and bounded retry/timeout on every external call (Claude, Soroban RPC,
  Horizon).
- Cryptographic worker session auth (`workerAuth.js`) — an address-format
  `workerId` must prove control of that key before submitting an answer.

## Running it

```sh
npm install
npm test              # 113 tests, no chain needed
cp .env.example .env  # fill in ORACLE_CONTRACT_ID / PLATFORM_SECRET for real use
npm start
```

Verified live against a real deployed contract on Stellar testnet — a full
paid question (payment → dispatch → reconcile → `resolve()`) and a real
sponsored `withdraw()` landing real USDC in a zero-XLM wallet. See the
original monorepo's README, "Round 6," for the full writeup including two
real bugs that live infrastructure surfaced and mocked tests never could.
