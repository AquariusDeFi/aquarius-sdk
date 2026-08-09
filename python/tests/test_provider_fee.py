"""No-network tests for provider-fee quotes and collector invocations."""

import json
import pathlib

import pytest
from stellar_sdk import Keypair, StrKey, scval

from aquarius import AquariusClient, AquariusError, Asset, ProviderFeeConfig, XLM


TESTDATA = pathlib.Path(__file__).resolve().parents[2] / "testdata"
TESTNET_PASSPHRASE = "Test SDF Network ; September 2015"
AQUA = Asset.classic("AQUA", "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER")
XLM_ID = XLM.contract_id(TESTNET_PASSPHRASE)
COLLECTOR_ID = StrKey.encode_contract(b"\x11" * 32)
FIXTURE = json.loads((TESTDATA / "find_path_testnet_xlm_aqua.json").read_text())


class RecordingBuilder:
    def append_invoke_contract_function_op(self, **kwargs):
        self.invocation = kwargs
        return self


@pytest.mark.parametrize(
    "fee_fraction,fee_denominator",
    [
        (-1, 10_000),
        (30, 0),
        (10_000, 10_000),
        (2**32, 2**32 + 1),
        (1, 2**32),
    ],
)
def test_provider_fee_config_rejects_values_outside_contract_domain(
    fee_fraction, fee_denominator
):
    with pytest.raises(AquariusError):
        ProviderFeeConfig(
            contract_id=COLLECTOR_ID,
            fee_fraction=fee_fraction,
            fee_denominator=fee_denominator,
        )


def test_exact_input_quote_and_destination_invocation_use_net_amounts():
    sender = Keypair.random()
    recipient = Keypair.random().public_key
    client = AquariusClient(network="testnet", signer=sender)
    requests = []

    def find_path(request, exact_input):
        requests.append((request, exact_input))
        return {**FIXTURE, "amount": "1000"}

    client.api.find_path = find_path
    provider_fee = ProviderFeeConfig(
        contract_id=COLLECTOR_ID,
        fee_fraction=30,
        fee_denominator=10_000,
        recipient=recipient,
    )

    quote = client.quote(
        XLM,
        AQUA,
        amount_in=100,
        slippage=0.01,
        provider_fee=provider_fee,
    )

    assert requests[0][0]["amount"] == "100"
    assert requests[0][1] is True
    assert quote.amount_out == 997
    assert quote.guard == 987
    assert quote._params["provider_fee"] is provider_fee

    builder = RecordingBuilder()
    client._swap_append(quote)(builder)
    invocation = builder.invocation
    params = invocation["parameters"]

    assert invocation["contract_id"] == COLLECTOR_ID
    assert invocation["function_name"] == "swap_chained_to"
    assert len(params) == 7
    assert scval.from_address(params[0]).address == sender.public_key
    assert scval.from_address(params[1]).address == recipient
    assert scval.from_address(params[3]).address == XLM_ID
    assert scval.from_uint128(params[4]) == 100
    assert scval.from_uint128(params[5]) == 987
    assert scval.from_uint32(params[6]) == 30


def test_exact_output_quote_grosses_up_route_and_uses_legacy_collector_method():
    sender = Keypair.random()
    client = AquariusClient(network="testnet", signer=sender)
    requests = []

    def find_path(request, exact_input):
        requests.append((request, exact_input))
        return {**FIXTURE, "amount": "999"}

    client.api.find_path = find_path
    provider_fee = ProviderFeeConfig(
        contract_id=COLLECTOR_ID,
        fee_fraction=30,
        fee_denominator=10_000,
    )

    quote = client.quote(
        XLM,
        AQUA,
        amount_out=997,
        slippage=0.01,
        provider_fee=provider_fee,
    )

    assert requests[0][0]["amount"] == "1000"
    assert requests[0][1] is False
    assert quote.amount_in == 999
    assert quote.amount_out == 997
    assert quote.guard == 1009

    builder = RecordingBuilder()
    client._swap_append(quote)(builder)
    invocation = builder.invocation
    params = invocation["parameters"]

    assert invocation["contract_id"] == COLLECTOR_ID
    assert invocation["function_name"] == "swap_chained_strict_receive"
    assert len(params) == 6
    assert scval.from_address(params[0]).address == sender.public_key
    assert scval.from_address(params[2]).address == XLM_ID
    assert scval.from_uint128(params[3]) == 997
    assert scval.from_uint128(params[4]) == 1009
    assert scval.from_uint32(params[5]) == 30


def test_exact_output_destination_uses_redirected_collector_abi():
    sender = Keypair.random()
    recipient = Keypair.random().public_key
    client = AquariusClient(network="testnet", signer=sender)
    client.api.find_path = lambda _request, _exact_input: {**FIXTURE, "amount": "999"}

    quote = client.quote(
        XLM,
        AQUA,
        amount_out=997,
        provider_fee=ProviderFeeConfig(
            contract_id=COLLECTOR_ID,
            fee_fraction=30,
            fee_denominator=10_000,
            recipient=recipient,
        ),
    )

    builder = RecordingBuilder()
    client._swap_append(quote)(builder)
    invocation = builder.invocation
    params = invocation["parameters"]

    assert invocation["contract_id"] == COLLECTOR_ID
    assert invocation["function_name"] == "swap_chained_strict_receive_to"
    assert len(params) == 7
    assert scval.from_address(params[0]).address == sender.public_key
    assert scval.from_address(params[1]).address == recipient
    assert scval.from_address(params[3]).address == XLM_ID
    assert scval.from_uint128(params[4]) == 997
    assert scval.from_uint128(params[5]) == 1009
    assert scval.from_uint32(params[6]) == 30
