from __future__ import annotations

from stellar_sdk import Keypair, TransactionEnvelope

from .errors import UserRejectedError, is_user_rejection

# A signer is anything that identifies an account and signs a transaction
# envelope. A stellar-sdk Keypair satisfies this as-is (public_key and secret
# attributes); custom signers provide `public_key` plus `sign(tx_xdr) -> str`
# returning the signed envelope XDR. Raw secret strings are never accepted.


def signer_public_key(signer) -> str:
    key = signer.public_key
    return key() if callable(key) else key


def sign_transaction(signer, tx: TransactionEnvelope, passphrase: str) -> TransactionEnvelope:
    try:
        secret = getattr(signer, "secret", None)
        if isinstance(secret, str):
            tx.sign(Keypair.from_secret(secret))
            return tx
        signed_xdr = signer.sign(tx.to_xdr())
        return TransactionEnvelope.from_xdr(signed_xdr, passphrase)
    except Exception as error:  # noqa: BLE001 — classify, then re-raise
        if is_user_rejection(error):
            raise UserRejectedError("Transaction cancelled by the user") from error
        raise
