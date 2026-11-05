from dataclasses import replace

import pytest
from stellar_sdk import Account, Network, SorobanDataBuilder, TransactionBuilder, scval

from aquarius import AquariusClient, ProviderFeeConfig, build_swap_split_operation, get_swap_minimum
from test_split_parity import FIXTURE, build_options, normalize, trustline


def options():
    return build_options(normalize(FIXTURE["plans"]["single"]["response"]), "1")


def test_contract_trust_is_nested_under_the_swap_root():
    op = build_swap_split_operation(**options(), trustline=trustline(FIXTURE["trustline"]))
    root = op.auth[0].root_invocation
    assert root.function.contract_fn.function_name.sc_symbol == b"swap_split"
    assert [c.function.contract_fn.function_name.sc_symbol for c in root.sub_invocations] == [b"trust", b"transfer"]


def test_provider_split_binds_collector_recipient_and_net_minimum():
    fee = ProviderFeeConfig(FIXTURE["batch"], 100, 10000)
    op = build_swap_split_operation(**options(), provider_fee=fee, trustline=trustline(FIXTURE["trustline"]))
    root = op.auth[0].root_invocation
    assert scval.from_address(root.sub_invocations[1].function.contract_fn.args[1]).address == fee.contract_id
    assert scval.from_uint32(root.function.contract_fn.args[-1]) == 100
    assert get_swap_minimum("101", "1", fee) == "98"
    fee = replace(fee, recipient=FIXTURE["router"])
    op = build_swap_split_operation(**options(), provider_fee=fee)
    assert op.host_function.invoke_contract.function_name.sc_symbol == b"swap_split_to"
    assert scval.from_address(op.host_function.invoke_contract.args[1]).address == fee.recipient
    with pytest.raises(ValueError, match="recipient"):
        build_swap_split_operation(**options(), provider_fee=fee, trustline=trustline(FIXTURE["trustline"]))


def test_fixed_assembly_preserves_auth_and_applies_headroom_without_simulation():
    from test_split_resources import Reader
    from test_submit import PreparingServer

    client = AquariusClient(network="testnet")
    server = PreparingServer()
    server.get_ledger_entries = Reader().get_ledger_entries
    client.engine.server = server
    op = build_swap_split_operation(**options())
    tx = (TransactionBuilder(Account(FIXTURE["source"], 1), Network.TESTNET_NETWORK_PASSPHRASE, 100)
          .append_operation(op).set_timeout(0).build())
    simulation = server.simulate_transaction(tx)
    simulation.min_resource_fee = 500
    simulation.transaction_data = SorobanDataBuilder().set_resources(400, 0, 0).set_resource_fee(500).build().to_xdr()
    server.simulations.clear()
    prepared = client.assemble_transaction(tx, op, simulation)
    data = prepared.transaction.soroban_data
    assert data.resources.instructions.uint32 == 500
    assert data.resource_fee.int64 >= 750
    assert prepared.transaction.operations[0].to_xdr_object() == op.to_xdr_object()
    assert server.simulations == []


@pytest.mark.parametrize("name", [k for k, p in FIXTURE["plans"].items() if "operationXdr" in p])
def test_shared_contract_trust_operation(name):
    entry = FIXTURE["plans"][name]
    op = build_swap_split_operation(
        **build_options(normalize(entry["response"]), entry["response"]["amount_out_min"]),
        trustline=trustline(FIXTURE["trustline"]),
    )
    assert op.to_xdr_object().to_xdr() == entry["contractTrustOperationXdr"]
