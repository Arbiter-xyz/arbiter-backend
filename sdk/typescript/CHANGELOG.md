# Changelog

## 0.1.0 — 2026-09-24

Initial release.

- `ArbiterClient` covering the agent-facing API: `POST /oracle` via all three
  payment paths (classic 402 challenge + `submitPayment`, prepaid balance with
  a payer session token, `Authorization: Bearer` API key), `POST /oracle/sandbox`,
  `GET /oracle/:jobId` with `waitForResult` polling, and `POST /oracle/:jobId/cancel`
  for the undo window.
- Payer session challenge/response (`authenticatePayer`) with a pluggable
  `TransactionSigner`, plus `keypairSigner` in `@arbiter-xyz/sdk/stellar`.
- Reads: payer balance and question history, worker owed/stake/reputation,
  leaderboard, stats.
- Typed models matching the backend's JSON, typed errors for 401/402/404/409/429,
  per-attempt timeouts, and retries limited to requests that are safe to repeat.
