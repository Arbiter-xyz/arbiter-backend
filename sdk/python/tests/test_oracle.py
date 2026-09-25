import httpx
import pytest

from arbiter_sdk import (
    AuthenticationError,
    ConflictError,
    InsufficientBalanceError,
    JobTimeoutError,
    PaymentRequiredError,
)

from .conftest import JOB_BASE, reply

CHALLENGE = {
    "questionId": "42",
    "amount": "0.2500000",
    "amountStroops": "2500000",
    "surgeMultiplier": 1,
    "asset": {"code": "USDC", "issuer": "GISSUER", "sacId": "CSAC"},
    "contractId": "CCONTRACT",
    "network": "Test SDF Network ; September 2015",
    "tier": "standard",
    "tiers": [
        {"key": "standard", "label": "Standard", "amount": "0.2500000", "amountStroops": "2500000", "quorumSize": 3, "timeoutMs": 45000}
    ],
    "quorumSize": 3,
    "timeoutMs": 45000,
    "autoRefundAfterLedgers": 100,
    "instructions": "Call submit(...)",
}
ACCEPTED = {"jobId": "42", "questionId": "42", "statusUrl": "/oracle/42", "cancellableUntil": 123, "cancelUrl": "/oracle/42/cancel"}
NOT_VISIBLE = {"questionId": "42", "reason": "payment not yet visible on-chain"}


# --- classic 402 flow -------------------------------------------------------


def test_request_challenge_returns_the_402_challenge(make_client):
    client, rec = make_client([reply(402, CHALLENGE)])
    challenge = client.request_challenge("Is the bridge open?", tier="standard", category="traffic")

    assert challenge.question_id == "42"
    assert challenge.amount_stroops == "2500000"
    assert challenge.contract_id == "CCONTRACT"
    assert challenge.tiers[0].key == "standard" and challenge.tiers[0].quorum_size == 3
    assert rec.requests[0].method == "POST" and rec.requests[0].url.path == "/oracle"
    assert rec.body() == {"question": "Is the bridge open?", "tier": "standard", "category": "traffic"}
    assert "authorization" not in rec.requests[0].headers


def test_request_challenge_retries_only_with_an_idempotency_key(make_client):
    client, rec = make_client([reply(503, {"error": "down"}), reply(402, CHALLENGE)])
    client.request_challenge("q", idempotency_key="idem-1")
    assert len(rec.requests) == 2
    assert rec.requests[1].headers["idempotency-key"] == "idem-1"

    client, rec = make_client([reply(503, {"error": "down"})])
    with pytest.raises(Exception):
        client.request_challenge("q")
    assert len(rec.requests) == 1, "without a key a retry would mint a second question id"


def test_submit_payment_sends_payment_headers(make_client):
    client, rec = make_client([reply(202, ACCEPTED)])
    accepted = client.submit_payment("42", "abc123")

    assert accepted.job_id == "42"
    assert accepted.cancellable_until == 123 and accepted.cancel_url == "/oracle/42/cancel"
    assert rec.requests[0].headers["x-question-id"] == "42"
    assert rec.requests[0].headers["x-payment-tx"] == "abc123"


def test_submit_payment_rechecks_while_payment_not_yet_visible(make_client):
    client, rec = make_client([reply(402, NOT_VISIBLE), reply(402, NOT_VISIBLE), reply(202, ACCEPTED)])
    assert client.submit_payment("42", "tx", poll_interval=0.001).job_id == "42"
    assert len(rec.requests) == 3


def test_submit_payment_fails_fast_on_a_real_payment_problem(make_client):
    client, rec = make_client([reply(402, {"questionId": "42", "reason": "on-chain payment amount is below the quoted price"})])
    with pytest.raises(PaymentRequiredError, match="below the quoted price"):
        client.submit_payment("42", "tx", poll_interval=0.001)
    assert len(rec.requests) == 1


def test_submit_payment_gives_up_after_wait_for_payment(make_client):
    client, _ = make_client(lambda req: reply(402, NOT_VISIBLE))
    with pytest.raises(PaymentRequiredError):
        client.submit_payment("42", "tx", wait_for_payment=0.02, poll_interval=0.005)


# --- metered flow -----------------------------------------------------------


def test_ask_metered_sends_payer_and_token_and_never_the_api_key(make_client):
    client, rec = make_client(
        [reply(202, {**ACCEPTED, "tier": "express", "amount": "0.4", "amountStroops": "4000000", "tiers": []})],
        api_key="ak_live_x",
    )
    accepted = client.ask_metered("q?", payer_address="GPAYER", token="sess.tok", tier="express")

    assert accepted.tier == "express" and accepted.amount_stroops == "4000000"
    assert rec.body() == {"question": "q?", "tier": "express", "category": None, "payerAddress": "GPAYER", "token": "sess.tok"}
    assert "authorization" not in rec.requests[0].headers


def test_insufficient_prepaid_balance_carries_deposit_instructions(make_client):
    client, _ = make_client(
        [reply(402, {"error": "insufficient prepaid balance", "payerAddress": "GPAYER", "instructions": "Call deposit(...)"})]
    )
    with pytest.raises(InsufficientBalanceError) as info:
        client.ask_metered("q", payer_address="GPAYER", token="t")
    assert isinstance(info.value, PaymentRequiredError)
    assert info.value.payer_address == "GPAYER"
    assert info.value.instructions == "Call deposit(...)"


def test_invalid_session_is_an_authentication_error(make_client):
    client, _ = make_client([reply(401, {"error": "a valid session token for this address is required"})])
    with pytest.raises(AuthenticationError, match="valid session token"):
        client.ask_metered("q", payer_address="G", token="bad")


def test_metered_ask_is_never_retried(make_client):
    client, rec = make_client([reply(500, {"error": "failed"}), reply(202, ACCEPTED)])
    with pytest.raises(Exception):
        client.ask_metered("q", payer_address="G", token="t")
    assert len(rec.requests) == 1


# --- API-key flow -----------------------------------------------------------


def test_ask_with_api_key_sends_the_bearer_key(make_client):
    client, rec = make_client([reply(202, ACCEPTED)], api_key="ak_live_abc")
    client.ask_with_api_key("q", tier="priority")
    assert rec.requests[0].headers["authorization"] == "Bearer ak_live_abc"
    assert rec.body()["tier"] == "priority"


def test_api_key_credit_and_busy_errors(make_client):
    client, _ = make_client([reply(402, {"error": "insufficient credit balance"})], api_key="ak_live_x")
    with pytest.raises(PaymentRequiredError) as info:
        client.ask_with_api_key("q")
    assert not isinstance(info.value, InsufficientBalanceError)

    client, rec = make_client([reply(503, {"error": "temporarily unable"}), reply(202, ACCEPTED)], api_key="ak_live_x")
    with pytest.raises(Exception):
        client.ask_with_api_key("q")
    assert len(rec.requests) == 1


def test_ask_with_api_key_requires_a_key(make_client):
    client, rec = make_client([])
    with pytest.raises(ValueError):
        client.ask_with_api_key("q")
    assert rec.requests == []


def test_ask_picks_the_payment_path(make_client):
    client, rec = make_client([reply(202, ACCEPTED)], api_key="ak_live_k")
    client.ask("q")
    assert rec.requests[0].headers["authorization"] == "Bearer ak_live_k"

    client, rec = make_client([reply(202, ACCEPTED)])
    client.ask("q", payer_address="GP", token="t")
    assert rec.body()["payerAddress"] == "GP"

    client, _ = make_client([])
    with pytest.raises(ValueError):
        client.ask("q")


# --- sandbox, polling, cancel ----------------------------------------------


def test_ask_sandbox(make_client):
    client, rec = make_client([reply(202, {"sandbox": True, "jobId": "7", "questionId": "7", "statusUrl": "/oracle/7", "note": "n"})])
    accepted = client.ask_sandbox("q", simulate="disagreement")
    assert accepted.job_id == "7" and accepted.sandbox is True
    assert rec.requests[0].url.path == "/oracle/sandbox"
    assert rec.body() == {"question": "q", "tier": None, "simulate": "disagreement"}


def test_wait_for_result_polls_until_settled(make_client):
    states = [
        reply(202, {**JOB_BASE, "status": "holding", "cancellableUntil": 5}),
        reply(202, {**JOB_BASE, "status": "awaiting_workers"}),
        reply(200, {**JOB_BASE, "status": "settled", "outcome": "resolved", "answer": "Yes", "confidence": 1, "matchingWorkers": ["GW1"]}),
    ]
    client, rec = make_client(states)
    seen = []
    job = client.wait_for_result("9", interval=0.001, on_update=lambda j: seen.append(j.status))

    assert job.resolved and job.answer == "Yes" and job.matching_workers == ["GW1"]
    assert job.job_id == "9"
    assert seen == ["holding", "awaiting_workers", "settled"]
    assert all(r.method == "GET" and r.url.path == "/oracle/9" for r in rec.requests)


def test_wait_for_result_times_out(make_client):
    client, _ = make_client(lambda req: reply(202, {**JOB_BASE, "status": "reconciling"}))
    with pytest.raises(JobTimeoutError) as info:
        client.wait_for_result("9", interval=0.005, timeout=0.02)
    assert info.value.last_status == "reconciling"


def test_cancel_with_session_token_or_api_key(make_client):
    settled = {**JOB_BASE, "jobId": "42", "status": "settled", "outcome": "refunded", "cancelledByPayer": True}
    client, rec = make_client([reply(200, settled)], api_key="ak_live_k")
    job = client.cancel("42", token="sess")
    assert job.cancelled_by_payer and job.outcome == "refunded"
    assert rec.requests[0].url.path == "/oracle/42/cancel"
    assert rec.body() == {"token": "sess"}
    assert "authorization" not in rec.requests[0].headers

    client, rec = make_client([reply(200, settled)], api_key="ak_live_k")
    client.cancel("42")
    assert rec.requests[0].headers["authorization"] == "Bearer ak_live_k"


def test_cancel_after_the_window_is_a_conflict(make_client):
    client, _ = make_client([reply(409, {"jobId": "42", "error": "already dispatched to workers — the undo window has closed"})])
    with pytest.raises(ConflictError, match="undo window"):
        client.cancel("42", token="t")


def test_unknown_fields_are_kept_in_raw(make_client):
    client, _ = make_client([reply(202, {**JOB_BASE, "status": "awaiting_workers", "brandNewField": 1})])
    assert client.get_job("1").raw["brandNewField"] == 1
