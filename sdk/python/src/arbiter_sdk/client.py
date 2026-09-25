"""Synchronous client for the Arbiter HTTP API."""

from __future__ import annotations

import time
from typing import Any, Callable, Iterable, List, Mapping, Optional
from urllib.parse import quote

import httpx

from .errors import ArbiterNetworkError, JobTimeoutError, PaymentRequiredError, error_for
from .models import (
    Job,
    LeaderboardEntry,
    OracleAccepted,
    PayerBalance,
    PayerQuestions,
    PaymentChallenge,
    SandboxAccepted,
    SandboxSimulation,
    Session,
    Stats,
    TierKey,
    WorkerOwed,
    WorkerReputation,
    WorkerStake,
)

TESTNET_PASSPHRASE = "Test SDF Network ; September 2015"
PUBLIC_PASSPHRASE = "Public Global Stellar Network ; September 2015"

#: Signs a challenge transaction (base64 XDR) for the given network
#: passphrase and returns the signed XDR. See :func:`arbiter_sdk.stellar.keypair_signer`.
TransactionSigner = Callable[[str, str], str]

_RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


def _seg(value: str) -> str:
    return quote(str(value), safe="")


class ArbiterClient:
    """Client for one Arbiter backend.

    Args:
        base_url: Backend origin, e.g. ``"http://localhost:4000"``.
        api_key: ``ak_live_...`` key for the API-key payment path. It is only
            sent on the calls that use it, because sending it on a metered
            request would switch the backend to the API-key path.
        network_passphrase: Network the backend signs challenges for.
            Defaults to testnet.
        timeout: Per-attempt timeout in seconds (default 15).
        max_retries: Extra attempts for requests that are safe to repeat
            (default 2). The metered and API-key ``POST /oracle`` calls are
            never retried: if a response is lost after the charge landed, a
            retry would charge again.
        retry_backoff: First retry delay in seconds, doubled per attempt.
        http_client: Bring your own ``httpx.Client`` (proxies, custom
            transport, tests). The client does not close one you pass in.

    Use as a context manager, or call :meth:`close`, to release connections.
    """

    def __init__(
        self,
        base_url: str,
        *,
        api_key: Optional[str] = None,
        network_passphrase: str = TESTNET_PASSPHRASE,
        timeout: float = 15.0,
        max_retries: int = 2,
        retry_backoff: float = 0.3,
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        if not base_url:
            raise ValueError("base_url is required")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.network_passphrase = network_passphrase
        self.timeout = timeout
        self.max_retries = max_retries
        self.retry_backoff = retry_backoff
        self._owns_http = http_client is None
        self._http = http_client or httpx.Client(timeout=timeout)

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def __enter__(self) -> "ArbiterClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ------------------------------------------------------------------
    # Transport
    # ------------------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
        retry: bool,
        accept: Iterable[int] = (),
    ) -> Any:
        url = f"{self.base_url}{path}"
        params = {k: v for k, v in (params or {}).items() if v is not None}
        attempts = self.max_retries + 1 if retry else 1
        accept = set(accept)
        last_exc: Exception = ArbiterNetworkError(f"{method} {path} failed")

        for attempt in range(1, attempts + 1):
            try:
                res = self._http.request(
                    method,
                    url,
                    json=json,
                    params=params,
                    headers={"Accept": "application/json", **(headers or {})},
                    timeout=self.timeout,
                )
            except httpx.TimeoutException as exc:
                last_exc = ArbiterNetworkError(f"{method} {path} timed out after {self.timeout}s")
                last_exc.__cause__ = exc
            except httpx.TransportError as exc:
                last_exc = ArbiterNetworkError(f"{method} {path} failed: {exc}")
                last_exc.__cause__ = exc
            else:
                body = _parse_body(res)
                if res.is_success or res.status_code in accept:
                    return body
                retry_after = _retry_after(res)
                last_exc = error_for(res.status_code, body, retry_after)
                if attempt < attempts and res.status_code in _RETRYABLE_STATUS:
                    time.sleep(retry_after if retry_after is not None else self.retry_backoff * 2 ** (attempt - 1))
                    continue
                raise last_exc

            if attempt < attempts:
                time.sleep(self.retry_backoff * 2 ** (attempt - 1))
        raise last_exc

    # ------------------------------------------------------------------
    # Asking questions: three payment paths on one endpoint
    # ------------------------------------------------------------------

    def request_challenge(
        self,
        question: str,
        *,
        tier: Optional[TierKey] = None,
        category: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> PaymentChallenge:
        """Classic flow, step 1: get a quote and a ``question_id``.

        Pay it yourself by calling the contract's
        ``submit(payer, question_id, amount_stroops)``, then call
        :meth:`submit_payment`. With an ``idempotency_key``, retrying after a
        lost response returns the same question id instead of minting a new one.
        """
        body = self._request(
            "POST",
            "/oracle",
            json={"question": question, "tier": tier, "category": category},
            headers={"Idempotency-Key": idempotency_key} if idempotency_key else None,
            accept=(402,),
            retry=bool(idempotency_key),
        )
        return PaymentChallenge.from_json(body)

    def submit_payment(
        self,
        question_id: str,
        payment_tx: str,
        *,
        wait_for_payment: float = 30.0,
        poll_interval: float = 2.0,
    ) -> OracleAccepted:
        """Classic flow, step 2: report the on-chain ``submit()`` transaction.

        Returns once the backend has verified payment (202). While it still
        reports "payment not yet visible on-chain", this re-checks every
        ``poll_interval`` seconds for up to ``wait_for_payment`` seconds,
        because RPC nodes can lag behind a transaction that already succeeded.
        Safe to retry: the backend treats this step as idempotent on the
        question id.
        """
        deadline = time.monotonic() + wait_for_payment
        while True:
            try:
                body = self._request(
                    "POST",
                    "/oracle",
                    json={},
                    headers={"X-Question-Id": str(question_id), "X-Payment-Tx": payment_tx},
                    retry=True,
                )
                return OracleAccepted.from_json(body)
            except PaymentRequiredError as exc:
                if "not yet visible" not in exc.message.lower() or time.monotonic() >= deadline:
                    raise
                time.sleep(poll_interval)

    def ask_metered(
        self,
        question: str,
        *,
        payer_address: str,
        token: str,
        tier: Optional[TierKey] = None,
        category: Optional[str] = None,
    ) -> OracleAccepted:
        """Charge against ``payer_address``'s prepaid on-chain balance, using a
        session token from :meth:`authenticate_payer`.

        Raises :class:`~arbiter_sdk.errors.InsufficientBalanceError` when the
        balance is too low. Not retried automatically.
        """
        body = self._request(
            "POST",
            "/oracle",
            json={
                "question": question,
                "tier": tier,
                "category": category,
                "payerAddress": payer_address,
                "token": token,
            },
            retry=False,
        )
        return OracleAccepted.from_json(body)

    def ask_with_api_key(
        self, question: str, *, tier: Optional[TierKey] = None, category: Optional[str] = None
    ) -> OracleAccepted:
        """Paid from the API-key account's fiat credit. Not retried automatically."""
        body = self._request(
            "POST",
            "/oracle",
            json={"question": question, "tier": tier, "category": category},
            headers={"Authorization": f"Bearer {self._require_api_key()}"},
            retry=False,
        )
        return OracleAccepted.from_json(body)

    def ask(
        self,
        question: str,
        *,
        tier: Optional[TierKey] = None,
        category: Optional[str] = None,
        payer_address: Optional[str] = None,
        token: Optional[str] = None,
    ) -> OracleAccepted:
        """Pick the payment path from what's available: the client's
        ``api_key`` if set, otherwise ``payer_address`` + ``token``. For the
        pay-per-call flow, use :meth:`request_challenge` and :meth:`submit_payment`."""
        if self.api_key:
            return self.ask_with_api_key(question, tier=tier, category=category)
        if payer_address and token:
            return self.ask_metered(question, payer_address=payer_address, token=token, tier=tier, category=category)
        raise ValueError(
            "set api_key on the client, or pass payer_address + token — or use "
            "request_challenge()/submit_payment() for pay-per-call"
        )

    def ask_sandbox(
        self, question: str, *, tier: Optional[TierKey] = None, simulate: Optional[SandboxSimulation] = None
    ) -> SandboxAccepted:
        """No payment, no chain: returns a real job to poll, tagged ``sandbox=True``."""
        body = self._request(
            "POST",
            "/oracle/sandbox",
            json={"question": question, "tier": tier, "simulate": simulate},
            retry=False,
        )
        return SandboxAccepted.from_json(body)

    # ------------------------------------------------------------------
    # Jobs
    # ------------------------------------------------------------------

    def get_job(self, job_id: str) -> Job:
        """Current job state. 202 (in flight) and 200 (settled) are both success."""
        return Job.from_json(self._request("GET", f"/oracle/{_seg(job_id)}", retry=True), job_id=job_id)

    def wait_for_result(
        self,
        job_id: str,
        *,
        interval: float = 1.0,
        timeout: float = 300.0,
        on_update: Optional[Callable[[Job], None]] = None,
    ) -> Job:
        """Poll until the job is settled, then return it. Check ``job.outcome``
        (or ``job.resolved``) for resolved vs refunded.

        Raises :class:`~arbiter_sdk.errors.JobTimeoutError` after ``timeout`` seconds.
        """
        deadline = time.monotonic() + timeout
        while True:
            job = self.get_job(job_id)
            if on_update:
                on_update(job)
            if job.is_settled:
                return job
            if time.monotonic() + interval > deadline:
                raise JobTimeoutError(job_id, timeout, job.status)
            time.sleep(interval)

    def cancel(self, job_id: str, *, token: Optional[str] = None) -> Job:
        """Cancel a paid question during its undo window (status ``holding``)
        and refund it. Authenticate with the payer's session ``token``, or, if
        the question was asked with an API key, the client's ``api_key``.
        Raises :class:`~arbiter_sdk.errors.ConflictError` once the window has closed."""
        use_api_key = not token and self.api_key
        body = self._request(
            "POST",
            f"/oracle/{_seg(job_id)}/cancel",
            json={"token": token} if token else {},
            headers={"Authorization": f"Bearer {self.api_key}"} if use_api_key else None,
            retry=False,
        )
        return Job.from_json(body, job_id=job_id)

    # ------------------------------------------------------------------
    # Payer session: prove control of a Stellar address
    # ------------------------------------------------------------------

    def create_payer_challenge(self, address: str) -> str:
        """A throwaway challenge transaction (base64 XDR, never submitted) to sign as ``address``."""
        return self._request("POST", f"/payers/{_seg(address)}/session/challenge", retry=True)["xdr"]

    def create_payer_session(self, address: str, signed_xdr: str) -> Session:
        """Exchange the signed challenge for a session token."""
        body = self._request("POST", f"/payers/{_seg(address)}/session", json={"signedXdr": signed_xdr}, retry=False)
        return Session.from_json(body)

    def authenticate_payer(self, address: str, signer: TransactionSigner) -> Session:
        """Challenge → sign → session in one call.

        ``signer(xdr, network_passphrase)`` must return the signed XDR, e.g.
        ``arbiter_sdk.stellar.keypair_signer(secret)``.
        """
        xdr = self.create_payer_challenge(address)
        return self.create_payer_session(address, signer(xdr, self.network_passphrase))

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    def get_payer_balance(self, address: str, *, token: Optional[str] = None) -> PayerBalance:
        """Prepaid balance. ``token`` is required for a real Stellar address."""
        body = self._request("GET", f"/payers/{_seg(address)}/balance", params={"token": token}, retry=True)
        return PayerBalance.from_json(body)

    def get_payer_questions(self, address: str, *, token: Optional[str] = None) -> PayerQuestions:
        """The payer's question history. ``token`` is required for a real Stellar address."""
        body = self._request("GET", f"/payers/{_seg(address)}/questions", params={"token": token}, retry=True)
        return PayerQuestions.from_json(body)

    def get_worker_owed(self, address: str) -> WorkerOwed:
        return WorkerOwed.from_json(self._request("GET", f"/workers/{_seg(address)}/owed", retry=True))

    def get_worker_stake(self, address: str) -> WorkerStake:
        return WorkerStake.from_json(self._request("GET", f"/workers/{_seg(address)}/stake", retry=True))

    def get_worker_reputation(self, address: str) -> WorkerReputation:
        return WorkerReputation.from_json(self._request("GET", f"/workers/{_seg(address)}/reputation", retry=True))

    def get_leaderboard(self, *, limit: Optional[int] = None) -> List[LeaderboardEntry]:
        """Established workers ranked by match ratio. The server caps ``limit`` at 200."""
        body = self._request("GET", "/leaderboard", params={"limit": limit}, retry=True)
        return [LeaderboardEntry.from_json(row) for row in body.get("leaderboard", [])]

    def get_stats(self) -> Stats:
        return Stats.from_json(self._request("GET", "/stats", retry=True))

    def _require_api_key(self) -> str:
        if not self.api_key:
            raise ValueError("this call needs the api_key option")
        return self.api_key


def _parse_body(res: httpx.Response) -> Any:
    if not res.content:
        return None
    try:
        return res.json()
    except ValueError:
        return res.text


def _retry_after(res: httpx.Response) -> Optional[float]:
    value = res.headers.get("retry-after")
    try:
        return float(value) if value is not None else None
    except ValueError:
        return None


__all__ = ["ArbiterClient", "TransactionSigner", "TESTNET_PASSPHRASE", "PUBLIC_PASSPHRASE"]
