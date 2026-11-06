from unittest.mock import Mock

import pytest

from aquarius import AquariusError
from test_limit_order_management import fill_receipt, prepared_client, route_xdr


@pytest.mark.parametrize("failure,stage,reason", [
    ("simulation", "simulation", "simulation_failed"),
    ("receipt", "receipt", "invalid_receipt"),
    ("auth", "authorization", "authorization_changed"),
    ("fee", "fee", "fee_cap"),
    ("payout", "receipt", "invalid_receipt"),
    ("count", "receipt", "invalid_result_count"),
    ("assembly", "assembly", "assembly_failed"),
])
def test_fill_failures_carry_safe_diagnostics_without_submitting(failure, stage, reason):
    client, record, filler, simulation = prepared_client()
    simulation.latest_ledger = 123
    if failure == "simulation":
        simulation.error = "HostError: Error(Contract, #205) PRIVATE-RPC-TEXT"
    elif failure == "receipt":
        simulation.results[0].xdr = "PRIVATE-XDR"
    elif failure == "auth":
        simulation.results[0].auth = ["PRIVATE-AUTH"]
    elif failure == "payout":
        simulation.results[0].xdr = fill_receipt(
            record.order_id, filler.public_key, maker_delta=0).to_xdr()
    elif failure == "count":
        simulation.results = []
    elif failure == "assembly":
        client.engine._assemble = Mock(side_effect=AquariusError("PRIVATE-ASSEMBLY"))
    else:
        client.engine._assemble = Mock(return_value=Mock(transaction=Mock(fee=5_000_000)))
    with pytest.raises(AquariusError) as caught:
        record.prepare_fill(route_xdr())
    context = caught.value.diagnostics
    assert (context["stage"], context["reason"]) == (stage, reason)
    assert context["simulation_ledger"] == 123
    assert context["reward_xlm"] == 5_000_000
    if failure == "simulation":
        assert context["contract_code"] == 205
    if failure == "fee":
        assert context["maximum_fee"] == 5_000_000
    assert "PRIVATE" not in repr(context)
    client.engine.sign_and_submit.assert_not_called()


def test_bad_route_has_route_diagnostics_before_rpc():
    client, record, _, _ = prepared_client()
    with pytest.raises(AquariusError) as caught:
        record.prepare_fill("PRIVATE-INVALID-XDR")
    assert caught.value.diagnostics == {"stage": "route", "reason": "invalid_route"}
    client.server.simulate_transaction.assert_not_called()


def test_invalid_context_retains_error_and_stops_before_rpc():
    client, record, _, _ = prepared_client()
    client._validate_limit_order_context = Mock(side_effect=AquariusError("PRIVATE-CONTEXT"))
    with pytest.raises(AquariusError, match="PRIVATE-CONTEXT") as caught:
        record.prepare_fill(route_xdr())
    assert caught.value.diagnostics == {"stage": "validation", "reason": "invalid_context"}
    client.server.simulate_transaction.assert_not_called()


def test_debug_event_code_is_not_reported_as_root_failure():
    client, record, _, simulation = prepared_client()
    simulation.error = "HostError: Error(Auth, InvalidAction)\nDebug: Error(Contract, #205)"
    with pytest.raises(AquariusError) as caught:
        record.prepare_fill(route_xdr())
    assert caught.value.diagnostics["reason"] == "simulation_failed"
    assert "contract_code" not in caught.value.diagnostics
