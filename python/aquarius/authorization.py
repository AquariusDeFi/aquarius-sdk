"""Client-built Soroban authorization entries.

The SDK states what a signature authorizes — deterministically, before
simulation — instead of echoing whatever the RPC's simulation returns.
Assembly preserves pre-built auth and only fills in resources.
"""
from __future__ import annotations

from stellar_sdk import Address
from stellar_sdk.xdr import (
    InvokeContractArgs,
    SCSymbol,
    SCVal,
    SorobanAuthorizationEntry,
    SorobanAuthorizedFunction,
    SorobanAuthorizedFunctionType,
    SorobanAuthorizedInvocation,
    SorobanCredentials,
    SorobanCredentialsType,
)


def authorized_contract_fn(contract_id: str, name: str, args: list[SCVal]) -> SorobanAuthorizedFunction:
    return SorobanAuthorizedFunction(
        type=SorobanAuthorizedFunctionType.SOROBAN_AUTHORIZED_FUNCTION_TYPE_CONTRACT_FN,
        contract_fn=InvokeContractArgs(
            contract_address=Address(contract_id).to_xdr_sc_address(),
            function_name=SCSymbol(name.encode()),
            args=args,
        ),
    )


def authorized_invocation(
    contract_id: str, name: str, args: list[SCVal],
    sub_invocations: list[SorobanAuthorizedInvocation] | None = None,
) -> SorobanAuthorizedInvocation:
    return SorobanAuthorizedInvocation(
        function=authorized_contract_fn(contract_id, name, args),
        sub_invocations=sub_invocations or [],
    )


def source_account_entry(root: SorobanAuthorizedInvocation) -> SorobanAuthorizationEntry:
    """An auth entry covered by the transaction envelope's own signature."""
    return SorobanAuthorizationEntry(
        credentials=SorobanCredentials(
            type=SorobanCredentialsType.SOROBAN_CREDENTIALS_SOURCE_ACCOUNT
        ),
        root_invocation=root,
    )
