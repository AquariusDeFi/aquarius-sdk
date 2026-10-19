import copy
import json
import pathlib
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from stellar_sdk import Address, Network, StrKey, scval

from aquarius import (
    AquariusClient,
    AquariusError,
    Asset,
    LimitOrderConfig,
    build_onchain_placement_args,
    validate_onchain_limit_order_draft,
)

TESTDATA = pathlib.Path(__file__).resolve().parents[2] / "testdata"
DRAFT = json.loads((TESTDATA / "limit_order_onchain_draft.json").read_text())
BATCHER = StrKey.encode_contract(bytes([5]) * 32)
XLM_TOKEN = StrKey.encode_contract(bytes([4]) * 32)


def native(value):
    if isinstance(value, Address):
        return value.address
    if isinstance(value, list):
        return [native(item) for item in value]
    return value


def validate(payload=None):
    return validate_onchain_limit_order_draft(
        payload or DRAFT,
        expected_network_passphrase=Network.TESTNET_NETWORK_PASSPHRASE,
        expected_settlement=DRAFT["settlement_address"],
        expected_maker=DRAFT["maker"],
        expected_order={
            "sell_token": DRAFT["sell_token"],
            "sell_amount": 1_000,
            "buy_token": DRAFT["buy_token"],
            "min_buy_amount": 900,
            "valid_after_ledger": 100,
            "expires_at_ledger": 200,
        },
        allowance_expiration_ledger=250,
    )


def test_limit_order_config_requires_contract_addresses():
    config = LimitOrderConfig(
        settlement=DRAFT["settlement_address"],
        batcher=BATCHER,
    )
    assert config.settlement == DRAFT["settlement_address"]
    with pytest.raises(AquariusError, match="batcher"):
        LimitOrderConfig(settlement=DRAFT["settlement_address"], batcher=DRAFT["maker"])


def test_onchain_draft_validates_canonical_xdr_and_json_projection():
    order = validate()
    assert order.order_id == DRAFT["order_id"]
    assert order.order_scval.to_xdr() == DRAFT["order_xdr"]
    assert order.allowance_expiration_ledger == 250
    assert order.required_allowances(XLM_TOKEN) == {
        DRAFT["sell_token"]: 1_000,
        XLM_TOKEN: 5_000_000,
    }

    changed = copy.deepcopy(DRAFT)
    changed["sell_amount"] = "1001"
    with pytest.raises(AquariusError, match="canonical order XDR"):
        validate(changed)

    changed = copy.deepcopy(DRAFT)
    changed["order_id"] = "00" * 32
    with pytest.raises(AquariusError, match="order ID"):
        validate(changed)

    changed = copy.deepcopy(DRAFT)
    changed["sell_amount"] = "not-an-integer"
    with pytest.raises(AquariusError, match="canonical order XDR"):
        validate(changed)

    with pytest.raises(AquariusError, match="allowance expiration"):
        validate_onchain_limit_order_draft(
            DRAFT,
            expected_network_passphrase=Network.TESTNET_NETWORK_PASSPHRASE,
            expected_settlement=DRAFT["settlement_address"],
            expected_maker=DRAFT["maker"],
            expected_order={
                "sell_token": DRAFT["sell_token"],
                "sell_amount": 1_000,
                "buy_token": DRAFT["buy_token"],
                "min_buy_amount": 900,
                "valid_after_ledger": 100,
                "expires_at_ledger": 200,
            },
            allowance_expiration_ledger=199,
        )


def test_onchain_placement_uses_idempotent_absolute_approvals_and_exact_marker():
    order = validate()
    args = build_onchain_placement_args(
        order,
        current_allowances={
            DRAFT["sell_token"]: 1_500,
            XLM_TOKEN: 4_000_000,
        },
        xlm_token=XLM_TOKEN,
    )

    assert native(scval.to_native(args[0])) == [DRAFT["maker"]]
    calls = native(scval.to_native(args[1]))
    assert calls == [
        [
            DRAFT["sell_token"],
            "approve",
            [DRAFT["maker"], DRAFT["settlement_address"], 1_500, 250],
        ],
        [
            XLM_TOKEN,
            "approve",
            [DRAFT["maker"], DRAFT["settlement_address"], 5_000_000, 250],
        ],
        [
            DRAFT["settlement_address"],
            "place_contract_order",
            [DRAFT["maker"], bytes.fromhex(DRAFT["order_id"]), 200],
        ],
    ]
    assert scval.to_native(args[2]) is False


def test_xlm_sale_uses_one_combined_allowance():
    order = replace(validate(), sell_token=XLM_TOKEN)

    assert order.required_allowances(XLM_TOKEN) == {XLM_TOKEN: 5_001_000}
    calls = native(
        scval.to_native(
            build_onchain_placement_args(
                order,
                current_allowances={XLM_TOKEN: 6_000_000},
                xlm_token=XLM_TOKEN,
            )[1]
        )
    )
    assert [call[1] for call in calls] == ["approve", "place_contract_order"]
    assert calls[0][2][2] == 6_000_000


def test_client_creates_validated_draft_and_builds_batcher_and_cancel_transactions():
    class Signer:
        public_key = DRAFT["maker"]

    client = AquariusClient(
        network="testnet",
        signer=Signer(),
        limit_orders=LimitOrderConfig(
            settlement=DRAFT["settlement_address"],
            batcher=BATCHER,
        ),
    )
    client.api.create_limit_order_draft = Mock(return_value=DRAFT)
    client.server.get_latest_ledger = Mock(return_value=SimpleNamespace(sequence=100))
    assert client.latest_ledger() == 100

    order = client.create_onchain_limit_order(
        Asset.contract(DRAFT["sell_token"]),
        Asset.contract(DRAFT["buy_token"]),
        sell_amount=1_000,
        min_buy_amount=900,
        valid_after_ledger=100,
        expires_at_ledger=200,
        allowance_expiration_ledger=250,
    )
    client.api.create_limit_order_draft.assert_called_once_with(
        client.network.limit_orders_api_url,
        {
            "placement_mode": "CONTRACT_ONCHAIN",
            "maker": DRAFT["maker"],
            "sell_token": DRAFT["sell_token"],
            "sell_amount": "1000",
            "buy_token": DRAFT["buy_token"],
            "min_buy_amount": "900",
            "valid_after_ledger": 100,
            "expires_at_ledger": 200,
        },
    )

    with pytest.raises(AquariusError, match="i128"):
        client.create_onchain_limit_order(
            Asset.contract(DRAFT["sell_token"]),
            Asset.contract(DRAFT["buy_token"]),
            sell_amount=2**127,
            min_buy_amount=900,
            valid_after_ledger=100,
            expires_at_ledger=200,
            allowance_expiration_ledger=250,
        )

    client._read_contract = Mock(return_value=scval.to_int128(0))
    captured = []

    class Builder:
        def append_invoke_contract_function_op(self, **kwargs):
            captured.append(kwargs)
            return self

    class Tx:
        def to_xdr(self):
            return "unsigned-xdr"

    def prepare(_source, append, _signer=None):
        append(Builder())
        return Tx()

    client.engine.prepare = prepare
    assert order.build_transaction() == "unsigned-xdr"
    assert captured[-1]["contract_id"] == BATCHER
    assert captured[-1]["function_name"] == "batch"
    assert [
        call[1] for call in native(scval.to_native(captured[-1]["parameters"][1]))
    ] == ["approve", "approve", "place_contract_order"]

    assert order.build_cancel_transaction() == "unsigned-xdr"
    assert captured[-1]["parameters"] == [order.order_scval]
    assert captured[-1]["auth"][0].root_invocation.function.contract_fn.function_name.sc_symbol == b"cancel"
    placement_auth = captured[-2]["auth"][0]
    assert [call.function.contract_fn.function_name.sc_symbol for call in placement_auth.root_invocation.sub_invocations] == [b"approve", b"approve", b"place_contract_order"]

    client.engine.sign_and_submit = Mock(
        return_value=SimpleNamespace(tx_hash="ab" * 32)
    )
    receipt = order.place()
    assert receipt.order_id == DRAFT["order_id"]
    assert receipt.tx_hash == "ab" * 32

    receipt = order.cancel()
    assert receipt.order_id == DRAFT["order_id"]
    assert receipt.tx_hash == "ab" * 32


def test_unsigned_placement_and_cancel_do_not_restore_or_submit():
    from stellar_sdk import Account, Keypair

    class Signer:
        def __init__(self):
            self.sign = Mock(side_effect=AssertionError("unsigned builder must not sign"))

        def public_key(self):
            return DRAFT["maker"]

    signer = Signer()
    client = AquariusClient(network="testnet", signer=signer, limit_orders=LimitOrderConfig(
        settlement=DRAFT["settlement_address"], batcher=BATCHER,
    ))
    order = replace(validate(), _client=client)
    client._read_contract = Mock(return_value=scval.to_int128(0))
    client.server.load_account = Mock(side_effect=lambda source: Account(source, 42))
    client.server.simulate_transaction = Mock(return_value=SimpleNamespace(restore_preamble=object()))
    client.engine.sign_and_submit = Mock(side_effect=AssertionError("unsigned builder must not submit"))
    for build in [order.build_transaction, order.build_cancel_transaction]:
        with pytest.raises(AquariusError, match="archived"):
            build()
    signer.sign.assert_not_called()
    client.engine.sign_and_submit.assert_not_called()


def test_unsigned_placement_does_not_restore_archived_allowance_read():
    from stellar_sdk import Account, Keypair

    client = AquariusClient(network="testnet", signer=Keypair.random(), limit_orders=LimitOrderConfig(
        settlement=DRAFT["settlement_address"], batcher=BATCHER,
    ))
    order = replace(validate(), _client=client)
    client.server.load_account = Mock(side_effect=lambda source: Account(source, 42))
    # Read simulation can return both an allowance and a restore preamble.
    client.server.simulate_transaction = Mock(return_value=SimpleNamespace(
        restore_preamble=object(), error=None,
        results=[SimpleNamespace(xdr=scval.to_int128(0).to_xdr())],
    ))
    client.engine._restore = Mock(side_effect=AssertionError("unsigned allowance read must not restore"))
    client.engine.prepare = Mock(return_value=SimpleNamespace(to_xdr=lambda: "unsigned-xdr"))
    assert order.build_transaction() == "unsigned-xdr"
    client.engine._restore.assert_not_called()


def test_network_config_keeps_existing_positional_factory_slot():
    from aquarius import NetworkConfig

    config = NetworkConfig("router", "api", "rpc", "horizon", "passphrase", "reader", "factory")
    assert config.collector_factory == "factory"
    assert config.limit_orders_api_url is None


@pytest.mark.parametrize("field,value,encoded,message", [
    ("version", 2, scval.to_uint32(2), "version"),
    ("salt", "78", scval.to_bytes(b"x"), "salt"),
    ("executor_reward_xlm", "0", scval.to_uint128(0), "amounts"),
    ("sell_amount", "1000", scval.to_uint64(1000), "canonical OrderV1"),
])
def test_draft_rejects_invalid_order_values_even_with_matching_json_and_xdr(field, value, encoded, message):
    import hashlib
    from stellar_sdk import xdr

    payload = copy.deepcopy(DRAFT)
    order = xdr.SCVal.from_xdr(payload["order_xdr"])
    for entry in order.map.sc_map:
        if scval.from_symbol(entry.key) == field:
            entry.val = encoded
    payload.update({field: value, "order_xdr": order.to_xdr(), "order_id": hashlib.sha256(order.to_xdr_bytes()).hexdigest()})
    with pytest.raises(AquariusError, match=message):
        validate(payload)


def test_placement_authorization_matches_shared_wire_vector():
    from aquarius.authorization import authorized_invocation, source_account_entry
    from stellar_sdk import Address

    vectors = json.loads((TESTDATA / "limit_order_vectors.json").read_text())
    args = build_onchain_placement_args(validate(), {}, XLM_TOKEN)
    calls = []
    for call in scval.from_vec(args[1]):
        target, name, parameters = scval.from_vec(call)
        calls.append(authorized_invocation(Address.from_xdr_sc_address(target.address).address, scval.from_symbol(name), scval.from_vec(parameters)))
    auth = source_account_entry(authorized_invocation(BATCHER, "batch", args, calls))
    assert [value.to_xdr() for value in args] == vectors["placement_args_xdr"]
    assert auth.to_xdr() == vectors["placement_auth_xdr"]


def test_onchain_auto_trust_is_in_the_same_placement_batch():
    asset = Asset.classic("USD", StrKey.encode_ed25519_public_key(bytes([6]) * 32))
    legacy = replace(
        validate(),
        buy_token=asset.contract_id(Network.TESTNET_NETWORK_PASSPHRASE),
        buy_asset=asset,
        network_passphrase=Network.TESTNET_NETWORK_PASSPHRASE,
    )
    order = replace(legacy, auto_trust=True)
    args = build_onchain_placement_args(order, {}, XLM_TOKEN)
    calls = scval.to_native(args[1])
    assert native(calls[0]) == [legacy.buy_token, "trust", [DRAFT["maker"]]]
    assert (
        len(calls)
        == len(scval.to_native(build_onchain_placement_args(legacy, {}, XLM_TOKEN)[1]))
        + 1
    )
    assert order.order_id == legacy.order_id


@pytest.mark.parametrize("asset", [None, Asset.contract(DRAFT["buy_token"]), Asset.native()])
def test_onchain_auto_trust_skips_assets_without_classic_issuer(asset):
    legacy = replace(validate(), buy_asset=asset)
    if asset is not None and asset.is_native:
        legacy = replace(legacy, buy_token=XLM_TOKEN)
    automatic = replace(legacy, auto_trust=True)
    assert [arg.to_xdr() for arg in build_onchain_placement_args(automatic, {}, XLM_TOKEN)] == [
        arg.to_xdr() for arg in build_onchain_placement_args(legacy, {}, XLM_TOKEN)
    ]


@pytest.mark.parametrize("passphrase", [None, Network.PUBLIC_NETWORK_PASSPHRASE, Network.TESTNET_NETWORK_PASSPHRASE])
def test_onchain_auto_trust_rejects_unverified_classic_metadata(passphrase):
    asset = Asset.classic("USD", StrKey.encode_ed25519_public_key(bytes([6]) * 32))
    buy_token = (
        DRAFT["buy_token"] if passphrase == Network.TESTNET_NETWORK_PASSPHRASE
        else asset.contract_id(Network.TESTNET_NETWORK_PASSPHRASE)
    )
    order = replace(validate(), auto_trust=True, buy_asset=asset,
                    buy_token=buy_token, network_passphrase=passphrase)
    with pytest.raises(AquariusError, match="classic receive asset"):
        build_onchain_placement_args(order, {}, XLM_TOKEN)


def test_onchain_auto_trust_skips_the_receive_asset_issuer():
    asset = Asset.classic("USD", DRAFT["maker"])
    order = replace(validate(), auto_trust=True, buy_asset=asset,
                    buy_token=asset.contract_id(Network.TESTNET_NETWORK_PASSPHRASE),
                    network_passphrase=Network.TESTNET_NETWORK_PASSPHRASE)
    calls = native(scval.to_native(build_onchain_placement_args(order, {}, XLM_TOKEN)[1]))
    assert [call[1] for call in calls] == ["approve", "approve", "place_contract_order"]


def test_client_preserves_classic_receive_metadata_for_the_placement_builder():
    import hashlib
    from stellar_sdk import xdr

    asset = Asset.classic("USD", StrKey.encode_ed25519_public_key(bytes([6]) * 32))
    buy_token = asset.contract_id(Network.TESTNET_NETWORK_PASSPHRASE)
    payload = copy.deepcopy(DRAFT)
    order_scval = xdr.SCVal.from_xdr(payload["order_xdr"])
    for entry in order_scval.map.sc_map:
        if scval.from_symbol(entry.key) == "buy_token":
            entry.val = scval.to_address(buy_token)
    payload.update(buy_token=buy_token, order_xdr=order_scval.to_xdr(),
                   order_id=hashlib.sha256(order_scval.to_xdr_bytes()).hexdigest())
    client = AquariusClient(
        network="testnet", signer=SimpleNamespace(public_key=DRAFT["maker"]),
        limit_orders=LimitOrderConfig(settlement=DRAFT["settlement_address"], batcher=BATCHER),
    )
    client.api.create_limit_order_draft = Mock(return_value=payload)
    order = client.create_onchain_limit_order(
        Asset.contract(DRAFT["sell_token"]), asset, sell_amount=1_000,
        min_buy_amount=900, valid_after_ledger=100, expires_at_ledger=200,
        allowance_expiration_ledger=250,
    )
    calls = native(scval.to_native(build_onchain_placement_args(order, {}, XLM_TOKEN)[1]))
    assert calls[0] == [buy_token, "trust", [DRAFT["maker"]]]
