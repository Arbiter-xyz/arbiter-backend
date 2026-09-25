"""Typed response models, mirrored from the backend's JSON.

Sources: ``server.js`` (routes), ``pricing.js`` (``listTiersForClient()`` /
``stroopsToUsdc()``), ``jobs.js`` / ``oracle.js`` (job records),
``metered.js``, ``leaderboard.js``, ``stats.js``.

Conventions:

* ``amount`` fields are USDC as a decimal string with 7 places; the matching
  ``amount_stroops`` is the same value as an integer string
  (1 USDC = 10,000,000 stroops). Use :func:`stroops_to_decimal` for math.
* Timestamps are Unix epoch **milliseconds**, as the backend sends them.
* Every model keeps the untouched JSON in ``raw``, so fields added to the
  API later are still reachable before this SDK models them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Dict, List, Literal, Optional

TierKey = Literal["instant", "standard", "express", "priority"]
JobStatus = Literal["holding", "awaiting_workers", "reconciling", "cancelling", "settled"]
JobOutcome = Literal["resolved", "refunded", "refund_pending_timeout", "lost_race_to_timeout_refund"]
SandboxSimulation = Literal["resolved", "disagreement", "no-answers"]

STROOPS_PER_USDC = 10_000_000


def stroops_to_decimal(stroops: str | int) -> Decimal:
    """``"2500000"`` -> ``Decimal("0.25")``."""
    return Decimal(int(stroops)) / STROOPS_PER_USDC


@dataclass(frozen=True)
class Tier:
    key: TierKey
    label: str
    amount: str
    amount_stroops: str
    quorum_size: int
    timeout_ms: int
    raw: Dict[str, Any] = field(repr=False, compare=False, default_factory=dict)

    @classmethod
    def from_json(cls, d: Dict[str, Any]) -> "Tier":
        return cls(
            key=d["key"],
            label=d.get("label", ""),
            amount=d.get("amount", ""),
            amount_stroops=d.get("amountStroops", ""),
            quorum_size=d.get("quorumSize", 0),
            timeout_ms=d.get("timeoutMs", 0),
            raw=d,
        )


def _tiers(d: Dict[str, Any]) -> List[Tier]:
    return [Tier.from_json(t) for t in d.get("tiers") or []]


@dataclass(frozen=True)
class PaymentChallenge:
    """402 body of ``POST /oracle`` without payment (classic flow, step 1)."""

    question_id: str
    amount: str
    amount_stroops: str
    surge_multiplier: float
    asset: Dict[str, str]
    contract_id: str
    network: str
    tier: TierKey
    tiers: List[Tier]
    quorum_size: int
    timeout_ms: int
    auto_refund_after_ledgers: int
    instructions: str
    raw: Dict[str, Any] = field(repr=False, compare=False, default_factory=dict)

    @classmethod
    def from_json(cls, d: Dict[str, Any]) -> "PaymentChallenge":
        return cls(
            question_id=str(d["questionId"]),
            amount=d.get("amount", ""),
            amount_stroops=d.get("amountStroops", ""),
            surge_multiplier=d.get("surgeMultiplier", 1),
            asset=d.get("asset") or {},
            contract_id=d.get("contractId", ""),
            network=d.get("network", ""),
            tier=d.get("tier", "standard"),
            tiers=_tiers(d),
            quorum_size=d.get("quorumSize", 0),
            timeout_ms=d.get("timeoutMs", 0),
            auto_refund_after_ledgers=d.get("autoRefundAfterLedgers", 0),
            instructions=d.get("instructions", ""),
            raw=d,
        )


@dataclass(frozen=True)
class OracleAccepted:
    """202 body once a paid question is accepted. Classic-flow responses carry
    ``question``/``quorum_size``/``timeout_ms``; metered and API-key responses
    carry ``tier``/``amount``/``amount_stroops``/``tiers``. ``cancellable_until``
    and ``cancel_url`` are set while the undo window is open."""

    job_id: str
    question_id: str
    status_url: str
    question: Optional[str] = None
    quorum_size: Optional[int] = None
    timeout_ms: Optional[int] = None
    tier: Optional[TierKey] = None
    amount: Optional[str] = None
    amount_stroops: Optional[str] = None
    tiers: List[Tier] = field(default_factory=list)
    cancellable_until: Optional[int] = None
    cancel_url: Optional[str] = None
    raw: Dict[str, Any] = field(repr=False, compare=False, default_factory=dict)

    @classmethod
    def from_json(cls, d: Dict[str, Any]) -> "OracleAccepted":
        return cls(
            job_id=str(d["jobId"]),
            question_id=str(d.get("questionId", d["jobId"])),
            status_url=d.get("statusUrl", f"/oracle/{d['jobId']}"),
            question=d.get("question"),
            quorum_size=d.get("quorumSize"),
            timeout_ms=d.get("timeoutMs"),
            tier=d.get("tier"),
            amount=d.get("amount"),
            amount_stroops=d.get("amountStroops"),
            tiers=_tiers(d),
            cancellable_until=d.get("cancellableUntil"),
            cancel_url=d.get("cancelUrl"),
            raw=d,
        )


@dataclass(frozen=True)
class SandboxAccepted:
    """202 body of ``POST /oracle/sandbox``. Always ``sandbox=True``."""

    job_id: str
    question_id: str
    status_url: str
    question: str
    tier: TierKey
    quorum_size: int
    timeout_ms: int
    note: str
    sandbox: bool = True
    raw: Dict[str, Any] = field(repr=False, compare=False, default_factory=dict)

    @classmethod
    def from_json(cls, d: Dict[str, Any]) -> "SandboxAccepted":
        return cls(
            job_id=str(d["jobId"]),
            question_id=str(d.get("questionId", d["jobId"])),
            status_url=d.get("statusUrl", f"/oracle/{d['jobId']}"),
            question=d.get("question", ""),
            tier=d.get("tier", "standard"),
            quorum_size=d.get("quorumSize", 0),
            timeout_ms=d.get("timeoutMs", 0),
            note=d.get("note", ""),
            sandbox=bool(d.get("sandbox", True)),
            raw=d,
        )


@dataclass(frozen=True)
class Job:
    """``GET /oracle/:jobId``. ``outcome`` and the answer fields appear once
    ``status == "settled"``; ``holding`` is the pre-dispatch undo window."""

    job_id: str
    status: JobStatus
    question: str
    tier: TierKey
    quorum_size: int
    timeout_ms: int
    created_at: int
    updated_at: int
    amount: Optional[str] = None
    amount_stroops: Optional[str] = None
    payer: Optional[str] = None
    sandbox: bool = False
    cancellable_until: Optional[int] = None
    dispatched_at: Optional[int] = None
    cancelled_at: Optional[int] = None
    cancelled_by_payer: bool = False
    outcome: Optional[JobOutcome] = None
    answer: Optional[str] = None
    confidence: Optional[float] = None
    reconciliation_method: Optional[str] = None
    total_answers: Optional[int] = None
    matching_workers: List[str] = field(default_factory=list)
    slashed_workers: List[str] = field(default_factory=list)
    payout_tx: Optional[str] = None
    payout_model: Optional[str] = None
    refund_tx: Optional[str] = None
    reason: Optional[str] = None
    auto_refund_after_ledgers: Optional[int] = None
    raw: Dict[str, Any] = field(repr=False, compare=False, default_factory=dict)

    @property
    def is_settled(self) -> bool:
        return self.status == "settled"

    @property
    def resolved(self) -> bool:
        return self.outcome == "resolved"

    @classmethod
    def from_json(cls, d: Dict[str, Any], job_id: Optional[str] = None) -> "Job":
        return cls(
            job_id=str(job_id or d.get("jobId") or d.get("questionId")),
            status=d.get("status", "awaiting_workers"),
            question=d.get("question", ""),
            tier=d.get("tier", "standard"),
            quorum_size=d.get("quorumSize", 0),
            timeout_ms=d.get("timeoutMs", 0),
            created_at=d.get("createdAt", 0),
            updated_at=d.get("updatedAt", 0),
            amount=d.get("amount"),
            amount_stroops=d.get("amountStroops"),
            payer=d.get("payer"),
            sandbox=bool(d.get("sandbox", False)),
            cancellable_until=d.get("cancellableUntil"),
            dispatched_at=d.get("dispatchedAt"),
            cancelled_at=d.get("cancelledAt"),
            cancelled_by_payer=bool(d.get("cancelledByPayer", False)),
            outcome=d.get("outcome"),
            answer=d.get("answer"),
            confidence=d.get("confidence"),
            reconciliation_method=d.get("reconciliationMethod"),
            total_answers=d.get("totalAnswers"),
            matching_workers=list(d.get("matchingWorkers") or []),
            slashed_workers=list(d.get("slashedWorkers") or []),
            payout_tx=d.get("payoutTx"),
            payout_model=d.get("payoutModel"),
            refund_tx=d.get("refundTx"),
            reason=d.get("reason"),
            auto_refund_after_ledgers=d.get("autoRefundAfterLedgers"),
            raw=d,
        )


@dataclass(frozen=True)
class Session:
    token: str
    expires_at: int

    @classmethod
    def from_json(cls, d: Dict[str, Any]) -> "Session":
        return cls(token=d["token"], expires_at=d.get("expiresAt", 0))


@dataclass(frozen=True)
class PayerBalance:
    payer_address: str
    balance: str
    balance_stroops: str
    instructions: str
    raw: Dict[str, Any] = field(repr=False, compare=False, default_factory=dict)

    @classmethod
    def from_json(cls, d: Dict[str, Any]) -> "PayerBalance":
        return cls(
            payer_address=d.get("payerAddress", ""),
            balance=d.get("balance", ""),
            balance_stroops=d.get("balanceStroops", ""),
            instructions=d.get("instructions", ""),
            raw=d,
        )


@dataclass(frozen=True)
class PayerQuestions:
    questions: List[Job]
    total_tracked: int
    total_spend: str
    total_spend_stroops: str
    success_rate: Optional[float]
    raw: Dict[str, Any] = field(repr=False, compare=False, default_factory=dict)

    @classmethod
    def from_json(cls, d: Dict[str, Any]) -> "PayerQuestions":
        return cls(
            questions=[Job.from_json(q, job_id=q.get("questionId")) for q in d.get("questions") or []],
            total_tracked=d.get("totalTracked", 0),
            total_spend=d.get("totalSpend", ""),
            total_spend_stroops=d.get("totalSpendStroops", ""),
            success_rate=d.get("successRate"),
            raw=d,
        )


@dataclass(frozen=True)
class WorkerOwed:
    owed: str
    owed_stroops: str

    @classmethod
    def from_json(cls, d: Dict[str, Any]) -> "WorkerOwed":
        return cls(owed=d.get("owed", ""), owed_stroops=d.get("owedStroops", ""))


@dataclass(frozen=True)
class WorkerStake:
    stake: str
    stake_stroops: str

    @classmethod
    def from_json(cls, d: Dict[str, Any]) -> "WorkerStake":
        return cls(stake=d.get("stake", ""), stake_stroops=d.get("stakeStroops", ""))


@dataclass(frozen=True)
class WorkerReputation:
    matched: int
    total: int
    match_ratio: Optional[float]

    @classmethod
    def from_json(cls, d: Dict[str, Any]) -> "WorkerReputation":
        return cls(matched=d.get("matched", 0), total=d.get("total", 0), match_ratio=d.get("matchRatio"))


@dataclass(frozen=True)
class LeaderboardEntry:
    worker_id: str
    total_answers: int
    matched: int
    match_ratio: Optional[float]
    stake: str
    stake_stroops: str
    established: bool

    @classmethod
    def from_json(cls, d: Dict[str, Any]) -> "LeaderboardEntry":
        return cls(
            worker_id=d["workerId"],
            total_answers=d.get("totalAnswers", 0),
            matched=d.get("matched", 0),
            match_ratio=d.get("matchRatio"),
            stake=d.get("stake", ""),
            stake_stroops=d.get("stakeStroops", ""),
            established=bool(d.get("established", False)),
        )


@dataclass(frozen=True)
class Stats:
    online_workers: int
    total_resolved: int
    total_refunded: int
    total_settled: int

    @classmethod
    def from_json(cls, d: Dict[str, Any]) -> "Stats":
        return cls(
            online_workers=d.get("onlineWorkers", 0),
            total_resolved=d.get("totalResolved", 0),
            total_refunded=d.get("totalRefunded", 0),
            total_settled=d.get("totalSettled", 0),
        )
