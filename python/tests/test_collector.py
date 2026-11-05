"""Provider-fee collectors: read/claim/deploy wiring and auth shape on a fake client."""
from dataclasses import replace

import pytest
from stellar_sdk import Address, scval

from aquarius import AquariusError, FeeCollector, ProviderFeeConfig
from aquarius.client import AquariusClient
from aquarius.submit import ConfirmedTx

COLLECTOR = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD"
TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
USDC = "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE"
OWNER = "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER"
DEST = "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA"

CHAIN_XDR = scval.to_vec([]).to_xdr()


class FakeQuote:
    def __init__(self, guard):
        self.guard = guard

        class Parsed:
            swap_chain_xdr = CHAIN_XDR

        self._parsed = Parsed()


class FakeClient:
    def __init__(self, reads=None):
        from aquarius.networks import NETWORKS

        self.network = NETWORKS["testnet"]
        self.reads = dict(reads or {})
        self.read_calls = []
        self.submitted = []
        self.submit_result = None
        self.quotes = []

    def _read_source(self, require_signer=False):
        return OWNER

    def _read_contract(self, contract_id, fn, args):
        self.read_calls.append((contract_id, fn, args))
        return self.reads[fn]

    def _submit_contract(self, contract_id, fn, args, auth=None):
        self.submitted.append((contract_id, fn, args, auth))
        return ConfirmedTx(tx_hash="h", return_value=self.submit_result)

    def quote(self, from_, to, *, amount_in, slippage):
        self.quotes.append((from_, to, amount_in, slippage))
        return FakeQuote(guard=amount_in * 99 // 100)


def collector(client) -> FeeCollector:
    return FeeCollector(address=COLLECTOR, _client=client)


def test_reads_wire_the_collector_contract():
    client = FakeClient(reads={
        "get_fee_destination": scval.to_address(DEST),
        "get_max_swap_fee_fraction": scval.to_uint32(100),
        "balance": scval.to_int128(12345),
    })
    c = collector(client)
    assert c.fee_destination() == DEST
    assert c.max_fee_fraction() == 100
    assert c.balance(TOKEN) == 12345
    contract_id, fn, args = client.read_calls[-1]
    assert contract_id == TOKEN and fn == "balance"
    assert Address.from_xdr_sc_address(args[0].address).address == COLLECTOR


def test_fee_config_builds_a_provider_fee_for_this_collector():
    config = collector(FakeClient()).fee_config(30, recipient=DEST)
    assert isinstance(config, ProviderFeeConfig)
    assert config.contract_id == COLLECTOR
    assert config.fee_fraction == 30 and config.fee_denominator == 10_000
    assert config.recipient == DEST


def test_claim_submits_root_only_operator_auth():
    client = FakeClient()
    client.submit_result = scval.to_uint128(777)
    claimed = collector(client).claim(TOKEN)

    contract_id, fn, args, auth = client.submitted[0]
    assert contract_id == COLLECTOR and fn == "claim_fees"
    assert Address.from_xdr_sc_address(args[0].address).address == OWNER
    assert Address.from_xdr_sc_address(args[1].address).address == TOKEN
    [entry] = auth
    root = entry.root_invocation
    assert root.function.contract_fn.function_name.sc_symbol == b"claim_fees"
    assert root.sub_invocations == []  # the contract moves its own tokens
    assert claimed.amount_in == 777 and claimed.amount_out == 777


def test_claim_and_swap_quotes_the_balance_and_guards_the_swap():
    client = FakeClient(reads={"balance": scval.to_int128(1000)})
    client.submit_result = scval.to_uint128(950)
    claimed = collector(client).claim_and_swap(TOKEN, USDC, slippage=0.05)

    (_, _, amount_in, slippage) = client.quotes[0]
    assert amount_in == 1000 and slippage == 0.05
    contract_id, fn, args, auth = client.submitted[0]
    assert fn == "claim_fees_and_swap"
    assert scval.from_uint128(args[3]) == 1000 * 99 // 100  # quote guard as out_min
    [entry] = auth
    assert entry.root_invocation.sub_invocations == []
    assert claimed.amount_in == 1000 and claimed.amount_out == 950


def test_balance_returns_zero_for_a_never_held_token():
    client = FakeClient()

    def raise_missing(contract_id, fn, args):
        raise AquariusError("HostError: Error(Storage, MissingValue)")

    client._read_contract = raise_missing
    assert collector(client).balance(TOKEN) == 0


def test_balance_reraises_other_read_errors():
    client = FakeClient()

    def raise_other(contract_id, fn, args):
        raise AquariusError("HostError: Error(Contract, #205)")

    client._read_contract = raise_other
    with pytest.raises(AquariusError, match="205"):
        collector(client).balance(TOKEN)


def test_claim_and_swap_refuses_an_empty_balance():
    client = FakeClient(reads={"balance": scval.to_int128(0)})
    with pytest.raises(AquariusError, match="Nothing to claim"):
        collector(client).claim_and_swap(TOKEN, USDC)


def test_deploy_wires_the_factory_and_returns_the_new_collector():
    client = AquariusClient.__new__(AquariusClient)  # no network calls
    from aquarius.networks import NETWORKS

    client.network = NETWORKS["mainnet"]
    submitted = []
    client._read_source = lambda require_signer=False: OWNER
    client._submit_contract = lambda c, f, a, auth=None: (
        submitted.append((c, f, a, auth)),
        ConfirmedTx(tx_hash="h", return_value=scval.to_address(COLLECTOR)),
    )[1]

    deployed = client.deploy_fee_collector(max_fee_fraction=100)
    contract_id, fn, args, auth = submitted[0]
    assert contract_id == client.network.collector_factory
    assert fn == "deploy_swap_fee_contract"
    assert Address.from_xdr_sc_address(args[0].address).address == OWNER
    assert Address.from_xdr_sc_address(args[1].address).address == OWNER  # dest defaults to operator
    assert args[2].u32.uint32 == 100 and args[3].u32.uint32 == 10_000
    assert deployed.address == COLLECTOR


def test_deploy_requires_a_factory_on_networks_without_one():
    client = AquariusClient.__new__(AquariusClient)
    from aquarius.networks import NETWORKS

    client.network = replace(NETWORKS["testnet"], collector_factory=None)
    client._read_source = lambda require_signer=False: OWNER
    with pytest.raises(AquariusError, match="factory"):
        client.deploy_fee_collector(max_fee_fraction=100)
