"""Exceptions raised by :class:`arbiter_sdk.ArbiterClient`.

Every non-2xx response becomes an :class:`ArbiterError` (or a subclass for
the cases callers usually branch on). ``body`` is the parsed JSON the
backend returned, when there was any.
"""

from __future__ import annotations

from typing import Any, Optional


class ArbiterError(Exception):
    """The API answered with an error status."""

    def __init__(self, message: str, status: int, body: Any = None) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.body = body


class PaymentRequiredError(ArbiterError):
    """402 — not paid for: payment not visible on-chain yet, underpaid,
    insufficient prepaid balance, or insufficient API credit."""

    def __init__(self, message: str, body: Any = None) -> None:
        super().__init__(message, 402, body)


class InsufficientBalanceError(PaymentRequiredError):
    """402 on the metered path: the payer's prepaid on-chain balance is too
    low. ``instructions`` explains how to ``deposit()`` more."""

    def __init__(self, message: str, body: Any = None) -> None:
        super().__init__(message, body)
        body = body if isinstance(body, dict) else {}
        self.payer_address: Optional[str] = body.get("payerAddress")
        self.instructions: Optional[str] = body.get("instructions")


class AuthenticationError(ArbiterError):
    """401 — missing, invalid, or expired session token or API key."""

    def __init__(self, message: str, body: Any = None) -> None:
        super().__init__(message, 401, body)


class RateLimitedError(ArbiterError):
    """429 — a per-IP rate limit was hit."""

    def __init__(self, message: str, body: Any = None, retry_after: Optional[float] = None) -> None:
        super().__init__(message, 429, body)
        self.retry_after = retry_after


class NotFoundError(ArbiterError):
    """404 — unknown or expired job id."""

    def __init__(self, message: str, body: Any = None) -> None:
        super().__init__(message, 404, body)


class ConflictError(ArbiterError):
    """409 — e.g. cancelling a question after its undo window closed."""

    def __init__(self, message: str, body: Any = None) -> None:
        super().__init__(message, 409, body)


class ArbiterNetworkError(Exception):
    """The request never got a response: network failure or timeout."""


class JobTimeoutError(Exception):
    """:meth:`ArbiterClient.wait_for_result` gave up before the job settled.
    The job itself may still settle later."""

    def __init__(self, job_id: str, timeout: float, last_status: Optional[str]) -> None:
        super().__init__(f"job {job_id} did not settle within {timeout}s (last status: {last_status or 'unknown'})")
        self.job_id = job_id
        self.last_status = last_status


def error_for(status: int, body: Any, retry_after: Optional[float] = None) -> ArbiterError:
    """Map an error response to the matching exception class."""
    message = f"Arbiter API responded with HTTP {status}"
    if isinstance(body, dict):
        message = body.get("error") or body.get("reason") or message
    elif isinstance(body, str) and body:
        message = body

    if status == 401:
        return AuthenticationError(message, body)
    if status == 402:
        if isinstance(body, dict) and "instructions" in body and "payerAddress" in body:
            return InsufficientBalanceError(message, body)
        return PaymentRequiredError(message, body)
    if status == 404:
        return NotFoundError(message, body)
    if status == 409:
        return ConflictError(message, body)
    if status == 429:
        return RateLimitedError(message, body, retry_after)
    return ArbiterError(message, status, body)
