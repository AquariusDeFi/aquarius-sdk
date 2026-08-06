from __future__ import annotations

from dataclasses import dataclass

from stellar_sdk import Asset as _StellarAsset

from .errors import AquariusError


@dataclass(frozen=True)
class Asset:
    """A token, however you happen to know it: native, code+issuer, or contract ID."""

    code: str | None = None
    issuer: str | None = None
    _contract: str | None = None

    @classmethod
    def native(cls) -> "Asset":
        return cls(code="XLM")

    @classmethod
    def classic(cls, code: str, issuer: str) -> "Asset":
        return cls(code=code, issuer=issuer)

    @classmethod
    def contract(cls, contract_id: str) -> "Asset":
        return cls(_contract=contract_id)

    @property
    def is_native(self) -> bool:
        return self._contract is None and self.issuer is None

    def contract_id(self, passphrase: str) -> str:
        if self._contract:
            return self._contract
        if self.is_native:
            return _StellarAsset.native().contract_id(passphrase)
        return _StellarAsset(self.code, self.issuer).contract_id(passphrase)

    def to_classic(self) -> _StellarAsset:
        """The classic-asset form, required for trustline operations."""
        if self._contract:
            raise AquariusError(
                "This asset is only known by contract ID — trustlines apply to classic assets"
            )
        if self.is_native:
            return _StellarAsset.native()
        return _StellarAsset(self.code, self.issuer)

    def __str__(self) -> str:
        return self.code or self._contract


XLM = Asset.native()
