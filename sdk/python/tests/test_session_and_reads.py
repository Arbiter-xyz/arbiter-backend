import re
import secrets

import httpx
import pytest
from stellar_sdk import Account, Keypair, TransactionBuilder, TransactionEnvelope

from arbiter_sdk import (
    TESTNET_PASSPHRASE,
    ArbiterClient,
    ArbiterNetworkError,
    AuthenticationError,
    NotFoundError,
    RateLimitedError,
    stroops_to_decimal,
)
from arbiter_sdk.stellar import keypair_signer

from .conftest import reply


def fake_session_server():
    """Builds and verifies the challenge the way the backend's workerAuth.js
    does: one manage_data "arbiter-auth" op carrying a nonce, sequence 0,
    signed once by the address itself."""
    nonces = {}

    def handler(req: httpx.Request) -> httpx.Response:
        m = re.fullmatch(r"/payers/([^/]+)/session(/challenge)?", req.url.path)
        if not m:
            return reply(404, {"error": "not found"})
        address = m.group(1)
        if m.group(2):
            nonce = secrets.token_hex(32)
            nonces[address] = nonce
            tx = (
                TransactionBuilder(Account(address, 0), TESTNET_PASSPHRASE, base_fee=100)
                .append_manage_data_op("arbiter-auth", nonce)
                .set_timeout(300)
                .build()
            )
            return reply(200, {"xdr": tx.to_xdr()})

        import json

        signed = TransactionEnvelope.from_xdr(json.loads(req.content)["signedXdr"], TESTNET_PASSPHRASE)
        op = signed.transaction.operations[0]
        sigs = signed.signatures
        try:
            Keypair.from_public_key(address).verify(signed.hash(), sigs[0].signature)
            valid = len(sigs) == 1
        except Exception:
            valid = False
        if not valid or op.data_value != nonces.get(address, "").encode():
            return reply(401, {"error": "challenge verification failed"})
        del nonces[address]
        return reply(200, {"token": f"token-for-{address}", "expiresAt": 999})

    return handler


def test_authenticate_payer_signs_the_challenge_and_returns_a_session(make_client):
    payer = Keypair.random()
    client, rec = make_client(fake_session_server())
    session = client.authenticate_payer(payer.public_key, keypair_signer(payer.secret))

    assert session.token == f"token-for-{payer.public_key}" and session.expires_at == 999
    assert [f"{r.method} {r.url.path}" for r in rec.requests] == [
        f"POST /payers/{payer.public_key}/session/challenge",
        f"POST /payers/{payer.public_key}/session",
    ]


def test_a_signature_from_another_key_is_rejected(make_client):
    payer, impostor = Keypair.random(), Keypair.random()
    client, _ = make_client(fake_session_server())
    with pytest.raises(AuthenticationError):
        client.authenticate_payer(payer.public_key, keypair_signer(impostor.secret))


def test_signer_receives_the_client_network_passphrase(make_client):
    seen = []
    client, _ = make_client(
        [reply(200, {"xdr": "XDR"}), reply(200, {"token": "t", "expiresAt": 1})],
        network_passphrase="Custom Net",
    )
    client.authenticate_payer("GADDR", lambda xdr, passphrase: seen.append((xdr, passphrase)) or "SIGNED")
    assert seen == [("XDR", "Custom Net")]


@pytest.mark.parametrize(
    "method, args, path, query, body",
    [
        ("get_payer_balance", ("GPAY",), "/payers/GPAY/balance", "token=tok",
         {"payerAddress": "GPAY", "balanceStroops": "10000000", "balance": "1.0000000", "instructions": "i"}),
        ("get_payer_questions", ("GPAY",), "/payers/GPAY/questions", "token=tok",
         {"questions": [{"questionId": "5", "status": "settled", "outcome": "resolved"}], "totalTracked": 1,
          "totalSpendStroops": "2500000", "totalSpend": "0.2500000", "successRate": 1}),
    ],
)
def test_payer_reads_pass_the_session_token(make_client, method, args, path, query, body):
    client, rec = make_client([reply(200, body)])
    result = getattr(client, method)(*args, token="tok")
    assert rec.requests[0].method == "GET"
    assert rec.requests[0].url.path == path
    assert rec.requests[0].url.query.decode() == query
    assert result.raw == body


def test_payer_models(make_client):
    client, _ = make_client([
        reply(200, {"payerAddress": "G", "balanceStroops": "12500000", "balance": "1.2500000", "instructions": "i"}),
        reply(200, {"questions": [{"questionId": "5", "status": "settled", "outcome": "resolved", "amountStroops": "2500000"}],
                    "totalTracked": 3, "totalSpendStroops": "2500000", "totalSpend": "0.2500000", "successRate": 1}),
    ])
    balance = client.get_payer_balance("G", token="t")
    assert stroops_to_decimal(balance.balance_stroops) == stroops_to_decimal("12500000")
    assert str(stroops_to_decimal(balance.balance_stroops)) == "1.25"

    history = client.get_payer_questions("G", token="t")
    assert history.total_tracked == 3 and history.success_rate == 1
    assert history.questions[0].job_id == "5" and history.questions[0].resolved


def test_worker_reads_leaderboard_and_stats(make_client):
    client, rec = make_client([
        reply(200, {"owedStroops": "5000000", "owed": "0.5000000"}),
        reply(200, {"stakeStroops": "0", "stake": "0.0000000"}),
        reply(200, {"matched": 8, "total": 10, "matchRatio": 0.8}),
        reply(200, {"leaderboard": [{"workerId": "GW", "totalAnswers": 9, "matched": 8, "matchRatio": 0.89,
                                     "stakeStroops": "0", "stake": "0.0000000", "established": True}]}),
        reply(200, {"onlineWorkers": 4, "totalResolved": 10, "totalRefunded": 2, "totalSettled": 12}),
    ])
    assert client.get_worker_owed("GW").owed_stroops == "5000000"
    assert client.get_worker_stake("GW").stake == "0.0000000"
    assert client.get_worker_reputation("GW").match_ratio == 0.8
    board = client.get_leaderboard(limit=10)
    assert board[0].worker_id == "GW" and board[0].established
    stats = client.get_stats()
    assert (stats.online_workers, stats.total_settled) == (4, 12)

    assert [r.url.path for r in rec.requests] == [
        "/workers/GW/owed", "/workers/GW/stake", "/workers/GW/reputation", "/leaderboard", "/stats",
    ]
    assert rec.requests[3].url.query.decode() == "limit=10"


def test_path_segments_are_encoded_and_a_base_path_is_kept(make_client):
    client, rec = make_client([reply(200, {"status": "settled"})], base_url="http://arbiter.test/api/v1/")
    client.get_job("a/b?c")
    assert rec.requests[0].url.raw_path.decode() == "/api/v1/oracle/a%2Fb%3Fc"


def test_unknown_job_is_not_found(make_client):
    client, _ = make_client([reply(404, {"error": "unknown or expired jobId"})])
    with pytest.raises(NotFoundError):
        client.get_job("nope")


# --- retries and timeouts ---------------------------------------------------


def test_gets_retry_on_429_and_5xx_then_succeed(make_client):
    client, rec = make_client([
        reply(429, {"error": "rate limit exceeded"}, headers={"Retry-After": "0"}),
        reply(502, {"error": "bad gateway"}),
        reply(200, {"onlineWorkers": 1, "totalResolved": 0, "totalRefunded": 0, "totalSettled": 0}),
    ])
    assert client.get_stats().online_workers == 1
    assert len(rec.requests) == 3


def test_persistent_429_raises_rate_limited(make_client):
    client, rec = make_client(lambda req: reply(429, {"error": "rate limit exceeded for oracle"}), max_retries=1)
    with pytest.raises(RateLimitedError):
        client.get_stats()
    assert len(rec.requests) == 2


def test_other_4xx_are_not_retried(make_client):
    client, rec = make_client(lambda req: reply(401, {"error": "nope"}))
    with pytest.raises(AuthenticationError):
        client.get_payer_balance("G")
    assert len(rec.requests) == 1


def test_connection_errors_are_retried_then_raised(make_client):
    client, rec = make_client(lambda req: httpx.ConnectError("refused", request=req), max_retries=2)
    with pytest.raises(ArbiterNetworkError):
        client.get_stats()
    assert len(rec.requests) == 3


def test_timeouts_raise_network_error(make_client):
    client, _ = make_client(lambda req: httpx.ReadTimeout("slow", request=req), max_retries=0, timeout=0.5)
    with pytest.raises(ArbiterNetworkError, match="timed out"):
        client.get_stats()


def test_base_url_is_required():
    with pytest.raises(ValueError):
        ArbiterClient("")
