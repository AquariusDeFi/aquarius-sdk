import json
from pathlib import Path
from dataclasses import replace
import pytest
from stellar_sdk import TransactionEnvelope, Keypair, xdr
from stellar_sdk.soroban_rpc import GetNetworkResponse, GetLedgerEntriesResponse
from aquarius.swap_resources import (
    load_swap_resource_limits,
    assert_swap_resources,
    assert_swap_authorization,
    get_swap_result,
)

FIXTURE = json.loads(
    (Path(__file__).parents[2] / "testdata/split-resources.json").read_text()
)
FIELDS = {
    "diskReadBytes": "disk_read_bytes",
    "writeBytes": "write_bytes",
    "diskReadEntries": "disk_read_entries",
    "writeEntries": "write_entries",
    "footprintEntries": "footprint_entries",
    "transactionSizeBytes": "transaction_size_bytes",
    "eventsAndReturnBytes": "events_and_return_bytes",
    "instructions": "instructions",
}


class Reader:
    def __init__(self, protocol=29):
        self.protocol = protocol

    def get_network(self):
        return GetNetworkResponse(
            passphrase=FIXTURE["networkPassphrase"], protocolVersion=self.protocol
        )

    def get_ledger_entries(self, keys):
        return GetLedgerEntriesResponse.model_validate(
            FIXTURE["configs"]["29" if self.protocol >= 23 else "22"]
        )


def transaction():
    return TransactionEnvelope.from_xdr(
        FIXTURE["transactionXdr"], FIXTURE["networkPassphrase"]
    )


def invocation():
    return {
        "events": [xdr.DiagnosticEvent.from_xdr(e) for e in FIXTURE["events"]],
        "retval": xdr.SCVal.from_xdr(FIXTURE["retval"]),
    }


def limits():
    value = load_swap_resource_limits(Reader(), FIXTURE["networkPassphrase"])
    return replace(value, **{v: 1000000 for v in FIELDS.values()})


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: c["name"])
def test_shared_resource_boundaries(case):
    current = replace(limits(), **{FIELDS[case["field"]]: case["limit"]})
    if case["ok"]:
        assert_swap_resources(transaction(), current, invocation())
    else:
        with pytest.raises(ValueError):
            assert_swap_resources(transaction(), current, invocation())


def test_configuration_and_fixed_auth():
    assert_swap_authorization(transaction(), FIXTURE["source"], FIXTURE["operationXdr"])
    with pytest.raises(ValueError):
        assert_swap_authorization(
            transaction(), Keypair.random().public_key, FIXTURE["operationXdr"]
        )
    tx = transaction()
    tx.transaction.operations[0].auth = []
    with pytest.raises(ValueError):
        assert_swap_authorization(tx, FIXTURE["source"], FIXTURE["operationXdr"])


def test_configuration_rejects_wrong_network_and_missing_keys():
    with pytest.raises(ValueError):
        load_swap_resource_limits(Reader(), "other network")
    reader = Reader()
    reader.get_ledger_entries = lambda keys: GetLedgerEntriesResponse(
        latestLedger=1, entries=[]
    )
    with pytest.raises(ValueError):
        load_swap_resource_limits(reader, FIXTURE["networkPassphrase"])


def test_shared_exact_builder_wire():
    from stellar_sdk import StrKey
    from aquarius import normalize_sell_swap_plan, build_sell_swap_operation

    api = json.loads(
        (Path(__file__).parents[2] / "testdata/split-api-response.json").read_text()
    )
    r = api["request"]
    plan = normalize_sell_swap_plan(
        api["response"], r["token_in_address"], r["token_out_address"], r["amount"]
    )
    operation = build_sell_swap_operation(
        source=FIXTURE["source"],
        token_in=r["token_in_address"],
        token_out=r["token_out_address"],
        router=StrKey.encode_contract(bytes([8]) * 32),
        split_router=StrKey.encode_contract(bytes([9]) * 32),
        plan=plan,
        minimum="123",
    )
    assert operation.to_xdr_object().to_xdr() == FIXTURE["operationXdr"]


@pytest.mark.parametrize("case", FIXTURE["footprintCases"], ids=lambda c: c["name"])
def test_shared_archived_footprint(case):
    current = replace(
        limits(), protocol_version=case["protocol"], disk_read_entries=case["limit"]
    )
    tx = TransactionEnvelope.from_xdr(
        case["transactionXdr"], FIXTURE["networkPassphrase"]
    )
    if case["ok"]:
        assert_swap_resources(tx, current, invocation())
    else:
        with pytest.raises(ValueError):
            assert_swap_resources(tx, current, invocation())


@pytest.mark.parametrize("case", FIXTURE["results"], ids=lambda c: c["name"])
def test_shared_results(case):
    from aquarius import get_sell_swap_result

    value = xdr.SCVal.from_xdr(case["xdr"])
    if case.get("error"):
        with pytest.raises(ValueError):
            get_sell_swap_result(value, case["legCount"], case["withTrustline"])
    else:
        assert (
            list(
                map(
                    str,
                    get_sell_swap_result(
                        value, case["legCount"], case["withTrustline"]
                    ),
                )
            )
            == case["expected"]
        )
    if case.get("ordinary"):
        assert get_swap_result(value, True).to_xdr() == value.vec.sc_vec[1].to_xdr()


def test_changed_global_minimum_rejected():
    from stellar_sdk import scval

    tx = transaction()
    tx.transaction.operations[0].auth[0].root_invocation.function.contract_fn.args[
        5
    ] = scval.to_uint128(124)
    with pytest.raises(ValueError):
        assert_swap_authorization(tx, FIXTURE["source"], FIXTURE["operationXdr"])


@pytest.mark.parametrize(
    "case", FIXTURE["configurationCases"], ids=lambda c: str(c["protocol"])
)
def test_shared_configuration_protocols(case):
    if case.get("error"):
        with pytest.raises(ValueError):
            load_swap_resource_limits(
                Reader(case["protocol"]), FIXTURE["networkPassphrase"]
            )
    else:
        result = load_swap_resource_limits(
            Reader(case["protocol"]), FIXTURE["networkPassphrase"]
        )
        assert result.instructions == 1000
        assert result.footprint_entries == case["footprint"]
        assert result.protocol_version == case["protocol"]


@pytest.mark.parametrize("kind", FIXTURE["configurationErrors"])
def test_shared_malformed_configuration(kind):
    server = Reader()
    original = server.get_ledger_entries

    def modified(keys):
        response = original(keys)
        if kind == "missing":
            response.entries = []
        if kind == "duplicate":
            response.entries.append(response.entries[0])
        if kind == "wrong_entry":
            response.entries[0].xdr = response.entries[1].xdr
        if kind == "invalid_ledger":
            response.latest_ledger = 0
        return response

    server.get_ledger_entries = modified
    with pytest.raises(ValueError):
        load_swap_resource_limits(
            server,
            "other network"
            if kind == "wrong_network"
            else FIXTURE["networkPassphrase"],
        )
