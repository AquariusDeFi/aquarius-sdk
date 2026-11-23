"""Current network limits and fixed-auth checks for prepared swap_split transactions.

Declarations include the RPC reserve. These checks do not measure memory or
replace full ordered simulation/Core admission. Never trim declarations to fit.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TypedDict

from stellar_sdk import MuxedAccount, SorobanServer, TransactionEnvelope, xdr

from .errors import ResourceLimitError


@dataclass
class SwapResourceLimits:
    network_passphrase: str
    protocol_version: int
    latest_ledger: int
    instructions: int
    disk_read_bytes: int
    write_bytes: int
    disk_read_entries: int
    write_entries: int
    transaction_size_bytes: int
    events_and_return_bytes: int
    footprint_entries: int | None = None


class SwapInvocation(TypedDict):
    events: list[xdr.DiagnosticEvent]
    retval: xdr.SCVal


def load_swap_resource_limits(
    connection: SorobanServer, network_passphrase: str
) -> SwapResourceLimits:
    """Fetch once per preparation, bound to the current network and ledger."""
    network = connection.get_network()
    if network.passphrase != network_passphrase:
        raise ValueError("Swap resource network changed.")
    protocol = network.protocol_version
    if type(protocol) is not int or not 20 <= protocol <= 30:
        raise ValueError("Unsupported swap resource configuration.")
    ids = [
        xdr.ConfigSettingID.CONFIG_SETTING_CONTRACT_COMPUTE_V0,
        xdr.ConfigSettingID.CONFIG_SETTING_CONTRACT_LEDGER_COST_V0,
        xdr.ConfigSettingID.CONFIG_SETTING_CONTRACT_BANDWIDTH_V0,
    ]
    if protocol >= 23:
        ids.append(xdr.ConfigSettingID.CONFIG_SETTING_CONTRACT_LEDGER_COST_EXT_V0)
    ids.append(xdr.ConfigSettingID.CONFIG_SETTING_CONTRACT_EVENTS_V0)
    keys = [
        xdr.LedgerKey(
            type=xdr.LedgerEntryType.CONFIG_SETTING,
            config_setting=xdr.LedgerKeyConfigSetting(setting),
        )
        for setting in ids
    ]
    response = connection.get_ledger_entries(keys)
    if (
        type(response.latest_ledger) is not int
        or not 0 < response.latest_ledger <= 2**53 - 1
    ):
        raise ValueError("Missing swap resource configuration.")
    configs = []
    for key, setting in zip(keys, ids):
        matches = [
            entry for entry in response.entries or [] if entry.key == key.to_xdr()
        ]
        if len(matches) != 1:
            raise ValueError("Missing swap resource configuration.")
        value = xdr.LedgerEntryData.from_xdr(matches[0].xdr)
        if (
            value.type != xdr.LedgerEntryType.CONFIG_SETTING
            or value.config_setting.config_setting_id != setting
        ):
            raise ValueError("Missing swap resource configuration.")
        configs.append(value.config_setting)
    compute, ledger = configs[0].contract_compute, configs[1].contract_ledger_cost
    limits = SwapResourceLimits(
        network_passphrase=network_passphrase,
        protocol_version=protocol,
        latest_ledger=response.latest_ledger,
        instructions=compute.tx_max_instructions.int64,
        disk_read_bytes=ledger.tx_max_disk_read_bytes.uint32,
        write_bytes=ledger.tx_max_write_bytes.uint32,
        disk_read_entries=ledger.tx_max_disk_read_entries.uint32,
        write_entries=ledger.tx_max_write_ledger_entries.uint32,
        footprint_entries=configs[
            3
        ].contract_ledger_cost_ext.tx_max_footprint_entries.uint32
        if protocol >= 23
        else None,
        transaction_size_bytes=configs[2].contract_bandwidth.tx_max_size_bytes.uint32,
        events_and_return_bytes=configs[
            -1
        ].contract_events.tx_max_contract_events_size_bytes.uint32,
    )
    if limits.instructions <= 0 or limits.transaction_size_bytes <= 0:
        raise ValueError("Invalid swap resource configuration.")
    return limits


def assert_swap_resources(
    tx: TransactionEnvelope,
    limits: SwapResourceLimits,
    invocation: SwapInvocation,
) -> None:
    if tx.network_passphrase != limits.network_passphrase:
        raise ValueError("Swap resource network changed.")
    envelope = tx.to_xdr_object()
    if envelope.type != xdr.EnvelopeType.ENVELOPE_TYPE_TX or envelope.v1.tx.ext.v != 1:
        raise ValueError("Invalid swap envelope.")
    data = envelope.v1.tx.ext.soroban_data
    resources = data.resources
    writes = resources.footprint.read_write
    keys = resources.footprint.read_only + writes
    archived = (
        [v.uint32 for v in data.ext.resource_ext.archived_soroban_entries]
        if data.ext.v == 1
        else []
    )

    def is_contract(key):
        return key.type in (
            xdr.LedgerEntryType.CONTRACT_DATA,
            xdr.LedgerEntryType.CONTRACT_CODE,
        )

    if (
        (limits.protocol_version < 23 and data.ext.v != 0)
        or len(set(archived)) != len(archived)
        or any(i >= len(writes) or not is_contract(writes[i]) for i in archived)
    ):
        raise ValueError("Invalid swap resource footprint.")
    disk_reads = (
        sum(not is_contract(key) for key in keys) + len(archived)
        if limits.protocol_version >= 23
        else len(keys)
    )
    signed_size = len(envelope.to_xdr_bytes()) + (20 - len(tx.signatures)) * 72
    events = invocation["events"]
    if not isinstance(events, list):
        raise ValueError("Missing swap simulation events.")
    event_bytes = len(invocation["retval"].to_xdr_bytes()) + sum(
        len(event.event.to_xdr_bytes())
        for event in events
        if event.in_successful_contract_call
        and event.event.type != xdr.ContractEventType.DIAGNOSTIC
    )
    checks = [
        ("instructions", resources.instructions.uint32, limits.instructions),
        ("disk read bytes", resources.disk_read_bytes.uint32, limits.disk_read_bytes),
        ("write bytes", resources.write_bytes.uint32, limits.write_bytes),
        ("disk read entries", disk_reads, limits.disk_read_entries),
        ("write entries", len(writes), limits.write_entries),
        ("transaction size", signed_size, limits.transaction_size_bytes),
        ("events and return bytes", event_bytes, limits.events_and_return_bytes),
    ]
    if limits.footprint_entries is not None:
        checks.append(("footprint entries", len(keys), limits.footprint_entries))
    for name, used, maximum in checks:
        if used > maximum:
            raise ResourceLimitError(f"Swap exceeds the network limit for {name}.",
                                     resource=name, used=str(used), limit=str(maximum))


def assert_swap_authorization(
    tx: TransactionEnvelope, source: str, expected: str
) -> None:
    """Simulation supplies resources, never additional spending authority."""
    operation = xdr.Operation.from_xdr(expected)
    if operation.body.type != xdr.OperationType.INVOKE_HOST_FUNCTION:
        raise ValueError("Invalid swap operation.")
    body = tx.transaction.to_xdr_object()
    if (
        tx.transaction.source.account_muxed or tx.transaction.source.account_id
    ) != source or len(body.operations) != 1:
        raise ValueError("Swap authorization changed. Please try again.")
    actual = body.operations[0]
    if (
        actual.body.type != xdr.OperationType.INVOKE_HOST_FUNCTION
        or (
            actual.source_account is not None
            and (
                MuxedAccount.from_xdr_object(actual.source_account).account_muxed
                or MuxedAccount.from_xdr_object(actual.source_account).account_id
            )
            != source
        )
        or actual.body.invoke_host_function_op.host_function.to_xdr()
        != operation.body.invoke_host_function_op.host_function.to_xdr()
        or [a.to_xdr() for a in actual.body.invoke_host_function_op.auth]
        != [a.to_xdr() for a in operation.body.invoke_host_function_op.auth]
    ):
        raise ValueError("Swap authorization changed. Please try again.")
