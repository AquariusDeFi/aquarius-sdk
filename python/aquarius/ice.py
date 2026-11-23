"""User-authorized ICE Locker and voting proxy calls."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from stellar_sdk import StrKey, scval

from .authorization import authorized_invocation, source_account_entry
from .errors import AquariusError

VotingProxy = Literal["upvote", "govern"]
BalanceProxy = Literal["ice", "upvote", "govern"]


@dataclass(frozen=True)
class IceContracts:
    """Verified addresses on the selected network, including the AQUA token contract."""
    locker: str
    aqua_token: str
    ice: str
    upvote: str
    govern: str


def _uint(value: int, bits: int, *, positive=False):
    lower_bound = 1 if positive else 0
    if type(value) is not int or not lower_bound <= value < (1 << bits):
        raise AquariusError(f"Value must fit in u{bits}" + (" and be positive" if positive else ""))
    return scval.to_uint64(value) if bits == 64 else scval.to_uint32(value)


class IceClient:
    def __init__(self, client, contracts: IceContracts | None):
        self._client = client
        self._contracts = contracts

    @property
    def contracts(self) -> IceContracts:
        if self._contracts is None:
            raise AquariusError("No ICE contracts configured for this network")
        return self._contracts

    def _proxy(self, proxy: str, *, voting=False):
        if proxy not in (("upvote", "govern") if voting else ("ice", "upvote", "govern")):
            raise AquariusError("Unknown ICE proxy")
        return getattr(self.contracts, proxy)

    def balance(self, owner: str, proxy: BalanceProxy,
                part: Literal["total", "retained", "incoming"] = "total") -> int:
        """Read raw voting power from the requested proxy."""
        methods = {"total": "balance", "retained": "get_retained_balance", "incoming": "get_incoming_balance"}
        if part not in methods:
            raise AquariusError("Unknown ICE balance component")
        value = self._client._read_contract(self._proxy(proxy), methods[part],
                                            [scval.to_address(owner)], allow_restore=False)
        return scval.from_int128(value)

    def delegations(self, owner: str, proxy: VotingProxy) -> list[tuple[str, int, int]]:
        """Return each delegate address, fraction and mature credit."""
        value = self._client._read_contract(self._proxy(proxy, voting=True), "delegations",
                                            [scval.to_address(owner)], allow_restore=False)
        result = []
        for row in scval.from_vec(value):
            target, fraction, credit = scval.from_vec(row)
            result.append((scval.from_address(target).address, scval.from_uint32(fraction),
                           scval.from_uint64(credit)))
        return result

    def _build(self, owner, contract, method, args, children=()):
        auth = source_account_entry(authorized_invocation(contract, method, args, list(children)))
        tx = self._client.engine.prepare(owner, lambda builder: builder.append_invoke_contract_function_op(
            contract_id=contract, function_name=method, parameters=args, auth=[auth],
        ))
        return tx.to_xdr()

    def build_create_lock(self, amount: int, unlock_time: int) -> str:
        """Build an unsigned lock transaction, including the exact AQUA transfer."""
        return self._create("create_lock", amount, unlock_time)

    def build_active_lock(self, amount: int, notice_seconds: int) -> str:
        """Build an active position with a notice period in seconds."""
        return self._create("create_shelf", amount, notice_seconds)

    def _create(self, method, amount, time_value):
        contracts = self.contracts
        owner = self._client._read_source(require_signer=True)
        address = scval.to_address(owner)
        args = [address, _uint(amount, 64, positive=True), _uint(time_value, 64)]
        transfer = authorized_invocation(contracts.aqua_token, "transfer", [
            address, scval.to_address(contracts.locker), scval.to_int128(amount),
        ])
        return self._build(owner, contracts.locker, method, args, [transfer])

    def build_withdraw(self, position_id: int) -> str:
        """Build an unsigned withdrawal for a matured contract position."""
        return self._position_call("withdraw", position_id)

    def build_start_unlock(self, position_id: int) -> str:
        return self._position_call("commit_shelf", position_id)

    def build_stop_unlock(self, position_id: int) -> str:
        return self._position_call("rearm_shelf", position_id)

    def _position_call(self, method, position_id):
        owner = self._client._read_source(require_signer=True)
        return self._build(owner, self.contracts.locker, method,
                           [scval.to_address(owner), _uint(position_id, 32)])

    def _delegation(self, proxy, target, fraction):
        contract = self._proxy(proxy, voting=True)
        owner = self._client._read_source(require_signer=True)
        if not StrKey.is_valid_ed25519_public_key(target) or target == owner:
            raise AquariusError("Select a different Stellar account as delegate")
        args = [scval.to_address(owner), scval.to_address(target)]
        if fraction is None:
            return self._build(owner, contract, "undelegate", args)
        args.append(_uint(fraction, 32, positive=True))
        return self._build(owner, contract, "delegate", args)

    def build_delegate(self, proxy: VotingProxy, delegate: str, fraction: int) -> str:
        """Set the total share for this delegate. 10,000,000 is 100%."""
        if type(fraction) is not int or not 0 < fraction <= 10_000_000:
            raise AquariusError("Delegation fraction must be in 1..10000000")
        return self._delegation(proxy, delegate, fraction)

    def build_undelegate(self, proxy: VotingProxy, delegate: str) -> str:
        return self._delegation(proxy, delegate, None)
