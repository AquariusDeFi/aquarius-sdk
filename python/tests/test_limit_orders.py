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

    def prepare(_source, append, _signer):
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
    assert captured[-1] == {
        "contract_id": DRAFT["settlement_address"],
        "function_name": "cancel",
        "parameters": [order.order_scval],
    }

    client.engine.sign_and_submit = Mock(
        return_value=SimpleNamespace(tx_hash="ab" * 32)
    )
    receipt = order.place()
    assert receipt.order_id == DRAFT["order_id"]
    assert receipt.tx_hash == "ab" * 32

    receipt = order.cancel()
    assert receipt.order_id == DRAFT["order_id"]
    assert receipt.tx_hash == "ab" * 32
