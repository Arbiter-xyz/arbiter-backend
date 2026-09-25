"""First-party Python client for the Arbiter human-intelligence oracle API.

Quick start (sandbox, no wallet needed)::

    from arbiter_sdk import ArbiterClient

    with ArbiterClient("http://localhost:4000") as arbiter:
        accepted = arbiter.ask_sandbox("Is the Third Mainland Bridge open right now?")
        job = arbiter.wait_for_result(accepted.job_id)
        print(job.outcome, job.answer)
"""

from .client import PUBLIC_PASSPHRASE, TESTNET_PASSPHRASE, ArbiterClient, TransactionSigner
from .errors import (
    ArbiterError,
    ArbiterNetworkError,
    AuthenticationError,
    ConflictError,
    InsufficientBalanceError,
    JobTimeoutError,
    NotFoundError,
    PaymentRequiredError,
    RateLimitedError,
)
from .models import (
    Job,
    LeaderboardEntry,
    OracleAccepted,
    PayerBalance,
    PayerQuestions,
    PaymentChallenge,
    SandboxAccepted,
    Session,
    Stats,
    Tier,
    WorkerOwed,
    WorkerReputation,
    WorkerStake,
    stroops_to_decimal,
)

__version__ = "0.1.0"

__all__ = [
    "ArbiterClient",
    "TransactionSigner",
    "TESTNET_PASSPHRASE",
    "PUBLIC_PASSPHRASE",
    "ArbiterError",
    "ArbiterNetworkError",
    "AuthenticationError",
    "ConflictError",
    "InsufficientBalanceError",
    "JobTimeoutError",
    "NotFoundError",
    "PaymentRequiredError",
    "RateLimitedError",
    "Job",
    "LeaderboardEntry",
    "OracleAccepted",
    "PayerBalance",
    "PayerQuestions",
    "PaymentChallenge",
    "SandboxAccepted",
    "Session",
    "Stats",
    "Tier",
    "WorkerOwed",
    "WorkerReputation",
    "WorkerStake",
    "stroops_to_decimal",
    "__version__",
]
