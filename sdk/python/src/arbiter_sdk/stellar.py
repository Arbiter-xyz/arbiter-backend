"""Optional helpers that need ``stellar-sdk`` (``pip install "arbiter-sdk[stellar]"``).

Kept out of the core package so plain HTTP use has one dependency (httpx).
"""

from __future__ import annotations

from .client import TransactionSigner

try:
    from stellar_sdk import Keypair, TransactionEnvelope
except ImportError as exc:  # pragma: no cover - exercised only without the extra
    raise ImportError(
        'arbiter_sdk.stellar needs the stellar extra: pip install "arbiter-sdk[stellar]"'
    ) from exc


def keypair_signer(secret: str) -> TransactionSigner:
    """A :data:`~arbiter_sdk.client.TransactionSigner` backed by a secret key (``S...``).

    The payer session challenge is a throwaway transaction that is never
    submitted; signing it only proves control of the address.
    """
    keypair = Keypair.from_secret(secret)

    def sign(xdr: str, network_passphrase: str) -> str:
        envelope = TransactionEnvelope.from_xdr(xdr, network_passphrase)
        envelope.sign(keypair)
        return envelope.to_xdr()

    return sign


__all__ = ["keypair_signer"]
