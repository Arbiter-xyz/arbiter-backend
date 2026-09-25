# Changelog

## 0.1.0 — 2026-09-24

Initial release.

- `ArbiterClient` covering the agent-facing API: `POST /oracle` via all three
  payment paths (classic 402 `request_challenge` + `submit_payment`, prepaid
  balance with a payer session token, `Authorization: Bearer` API key),
  `POST /oracle/sandbox`, `GET /oracle/:jobId` with `wait_for_result` polling,
  and `POST /oracle/:jobId/cancel` for the undo window.
- Payer session challenge/response (`authenticate_payer`) with a pluggable
  signer, plus `keypair_signer` behind the optional `stellar` extra.
- Reads: payer balance and question history, worker owed/stake/reputation,
  leaderboard, stats.
- Frozen dataclass models matching the backend's JSON, typed exceptions for
  401/402/404/409/429, per-attempt timeouts, and retries limited to requests
  that are safe to repeat.
