# arbiter-sdk (Python)

Python client for the [Arbiter](https://github.com/Arbiter-xyz/arbiter-backend) API: ask a question, pay for it, and poll for a human-verified answer. It handles the two-step 402 flow, payer session auth, polling, retries, and typed errors, so an agent tool or script doesn't have to.

```sh
pip install arbiter-sdk
# add session signing from a secret key (payer challenge/response):
pip install "arbiter-sdk[stellar]"
```

Requires Python 3.9+. The only core dependency is `httpx`.

## Ask and poll: sandbox, no wallet needed

```python
from arbiter_sdk import ArbiterClient

with ArbiterClient("http://localhost:4000") as arbiter:
    accepted = arbiter.ask_sandbox("Is the Third Mainland Bridge open right now?")
    job = arbiter.wait_for_result(accepted.job_id, on_update=lambda j: print(j.status))

    print(job.outcome)      # "resolved"
    print(job.answer)       # the consensus answer
    print(job.confidence)   # 0..1
```

`POST /oracle/sandbox` needs no payment, chain, or LLM key, and returns a job with the same shape as a paid one. Pass `simulate="disagreement"` or `simulate="no-answers"` to get the refund shapes. A runnable version is in [`examples/sandbox.py`](examples/sandbox.py):

```sh
ARBITER_URL=http://localhost:4000 python examples/sandbox.py
```

## Asking a real question

`POST /oracle` supports three ways to pay. All three return an `OracleAccepted` with a `job_id`. Then `wait_for_result(job_id)` returns the settled `Job`: `job.resolved` means `job.answer` is set; a `refunded` or `refund_pending_timeout` outcome means you weren't charged.

### 1. API key (no wallet)

Paid from credit bought through Stripe (`POST /billing/checkout`):

```python
arbiter = ArbiterClient(base_url, api_key="ak_live_...")
accepted = arbiter.ask_with_api_key("Is this invoice a duplicate?", tier="express")
job = arbiter.wait_for_result(accepted.job_id)
```

### 2. Prepaid balance (payer address + session token)

Fund once by calling the contract's `deposit()` yourself. After that, prove control of the payer address once per session and ask with no per-question signing:

```python
from arbiter_sdk.stellar import keypair_signer

session = arbiter.authenticate_payer(payer_address, keypair_signer(os.environ["PAYER_SECRET"]))

accepted = arbiter.ask_metered(
    "What does this sign say?",
    payer_address=payer_address,
    token=session.token,
    tier="standard",
)
```

`authenticate_payer` fetches a throwaway challenge transaction (`POST /payers/:address/session/challenge`), signs it with your signer (it is never submitted), and exchanges it for a session token (`POST /payers/:address/session`). This is the same proof-of-control flow the backend's `workerAuth.js` implements. A signer is any `(xdr, network_passphrase) -> signed_xdr` callable, so an HSM or custodial signer works too. For mainnet, pass `network_passphrase=PUBLIC_PASSPHRASE`.

### 3. Pay per call (the 402 flow)

```python
import uuid

challenge = arbiter.request_challenge(
    "Is the venue wheelchair accessible?",
    tier="priority",
    idempotency_key=str(uuid.uuid4()),   # retries return the same question_id
)

# Pay on-chain yourself:
#   submit(payer, challenge.question_id, challenge.amount_stroops) on challenge.contract_id
accepted = arbiter.submit_payment(challenge.question_id, tx_hash)
job = arbiter.wait_for_result(accepted.job_id)
```

`submit_payment` keeps re-checking for up to 30s (`wait_for_payment`) while the backend reports the payment as "not yet visible on-chain", because RPC nodes can lag behind a successful transaction.

`ask(question, ...)` picks the API-key path if the client has `api_key`, otherwise the metered path when you pass `payer_address` and `token`.

### Undo window

Paid non-instant questions are held for a few seconds before workers see them (`job.status == "holding"`, until `accepted.cancellable_until`). During that window you can cancel and get refunded:

```python
arbiter.cancel(accepted.job_id, token=session.token)   # or no token → uses the client's api_key
```

After the window closes, `cancel` raises `ConflictError`.

## Reference

| Method | Endpoint |
| --- | --- |
| `get_job(job_id)` | `GET /oracle/:jobId` |
| `get_payer_balance(address, token=...)` | `GET /payers/:address/balance` |
| `get_payer_questions(address, token=...)` | `GET /payers/:address/questions` |
| `get_worker_owed(address)` | `GET /workers/:address/owed` |
| `get_worker_stake(address)` | `GET /workers/:address/stake` |
| `get_worker_reputation(address)` | `GET /workers/:address/reputation` |
| `get_leaderboard(limit=...)` | `GET /leaderboard` |
| `get_stats()` | `GET /stats` |

Response models are frozen dataclasses with snake_case fields (`Job`, `OracleAccepted`, `PaymentChallenge`, `PayerBalance`, …). Each keeps the untouched JSON in `.raw`. Amounts come as `amount` (decimal USDC string) and `amount_stroops` (integer string; 1 USDC = 10,000,000 stroops); `stroops_to_decimal()` converts. Timestamps are epoch milliseconds, as the API sends them.

## Errors, retries, timeouts

| Exception | When |
| --- | --- |
| `PaymentRequiredError` | 402: unpaid, underpaid, or out of API credit |
| `InsufficientBalanceError` | 402 on the metered path; `.instructions` explains how to `deposit()` |
| `AuthenticationError` | 401: bad or expired session token or API key |
| `RateLimitedError` | 429 (`.retry_after` in seconds when the server sends it) |
| `NotFoundError` / `ConflictError` | 404 unknown job / 409 e.g. cancel after the undo window |
| `ArbiterNetworkError` | no response: connection failure or timeout |
| `JobTimeoutError` | `wait_for_result` gave up; the job may still settle later |

All HTTP errors subclass `ArbiterError` (`.status`, `.body`).

Each attempt times out after `timeout` seconds (default 15). Requests that are safe to repeat (every GET, session calls, `submit_payment`, and `request_challenge` with an `idempotency_key`) are retried up to `max_retries` times (default 2) on connection errors, 408/425/429, and 5xx, with exponential backoff that honours `Retry-After`. `ask_metered`, `ask_with_api_key`, `ask_sandbox`, and `cancel` are **never** retried automatically: if a response is lost after the charge landed, a retry would charge twice. Check `get_payer_questions` before trying again.

Pass `http_client=httpx.Client(...)` to control proxies, TLS, or transport.

## Development

```sh
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
pytest
```

The test suite mocks the HTTP layer with `httpx.MockTransport`; no backend is needed.

### Publishing

1. Bump `version` in `pyproject.toml` and `arbiter_sdk/__init__.py`, and add a `CHANGELOG.md` entry.
2. `python -m build && twine upload dist/*`. This needs PyPI credentials for the `arbiter-sdk` project, which a maintainer has to set up; until then, install from source with `pip install ./sdk/python`.
