from __future__ import annotations

import hashlib
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from stellar_sdk import Account, Address, Keypair, Network, StrKey, scval, xdr
from stellar_sdk.auth import authorize_entry

from aquarius import (
    AquariusClient,
    AquariusError,
    Asset,
    LimitOrderConfig,
    NoRouteError,
    parse_limit_order_record,
    route_scval_from_swap_chain,
    validate_fill_receipt,
)


def contract(seed: int) -> str:
    return StrKey.encode_contract(bytes([seed]) * 32)


SETTLEMENT = contract(1)
SELL_TOKEN = contract(2)
BUY_TOKEN = contract(3)
NETWORK = Network.TESTNET_NETWORK_PASSPHRASE
XLM_TOKEN = Asset.native().contract_id(NETWORK)


def order_scval(maker: str, placement_mode: str = "Detached") -> xdr.SCVal:
    return scval.to_struct(
        {
            "version": scval.to_uint32(1),
            "placement_mode": scval.to_vec([scval.to_symbol(placement_mode)]),
            "salt": scval.to_bytes(bytes(range(32))),
            "maker": scval.to_address(maker),
            "sell_token": scval.to_address(SELL_TOKEN),
            "sell_amount": scval.to_uint128(1_000),
            "buy_token": scval.to_address(BUY_TOKEN),
            "min_buy_amount": scval.to_uint128(900),
            "valid_after_ledger": scval.to_uint32(100),
            "expires_at_ledger": scval.to_uint32(200),
            "executor_reward_xlm": scval.to_uint128(5_000_000),
        }
    )


def authorization_invocation(order: xdr.SCVal, maker: str) -> xdr.SorobanAuthorizedInvocation:
    maker_value = scval.to_address(maker)
    settlement_value = scval.to_address(SETTLEMENT)

    def contract_call(contract_id, function_name, args, sub_invocations=None):
        return xdr.SorobanAuthorizedInvocation(
            function=xdr.SorobanAuthorizedFunction(
                type=xdr.SorobanAuthorizedFunctionType.SOROBAN_AUTHORIZED_FUNCTION_TYPE_CONTRACT_FN,
                contract_fn=xdr.InvokeContractArgs(
                    contract_address=Address(contract_id).to_xdr_sc_address(),
                    function_name=xdr.SCSymbol(function_name.encode()),
                    args=args,
                ),
            ),
            sub_invocations=sub_invocations or [],
        )

    return contract_call(
        SETTLEMENT,
        "fill",
        [order],
        [
            contract_call(
                SELL_TOKEN,
                "transfer",
                [maker_value, settlement_value, scval.to_int128(1_000)],
            ),
            contract_call(
                XLM_TOKEN,
                "transfer",
                [maker_value, settlement_value, scval.to_int128(5_000_000)],
            ),
        ],
    )


def detached_payload() -> tuple[dict, Keypair]:
    maker = Keypair.random()
    order = order_scval(maker.public_key)
    unsigned = xdr.SorobanAuthorizationEntry(
        credentials=xdr.SorobanCredentials(
            type=xdr.SorobanCredentialsType.SOROBAN_CREDENTIALS_ADDRESS_V2,
            address_v2=xdr.SorobanAddressCredentials(
                address=Address(maker.public_key).to_xdr_sc_address(),
                nonce=xdr.Int64(42),
                signature_expiration_ledger=xdr.Uint32(200),
                signature=xdr.SCVal(type=xdr.SCValType.SCV_VOID),
            ),
        ),
        root_invocation=authorization_invocation(order, maker.public_key),
    )
    signed = authorize_entry(unsigned, maker, 200, NETWORK)
    order_id = hashlib.sha256(order.to_xdr_bytes()).hexdigest()
    return (
        {
            "order_id": order_id,
            "status": "OPEN",
            "version": 1,
            "placement_mode": "DETACHED",
            "network_id": Network(NETWORK).network_id().hex(),
            "settlement_address": SETTLEMENT,
            "salt": bytes(range(32)).hex(),
            "maker": maker.public_key,
            "sell_token": SELL_TOKEN,
            "sell_amount": "1000",
            "buy_token": BUY_TOKEN,
            "min_buy_amount": "900",
            "valid_after_ledger": 100,
            "expires_at_ledger": 200,
            "executor_reward_xlm": "5000000",
            "order_xdr": order.to_xdr(),
            "authorization_xdr": signed.to_xdr(),
        },
        maker,
    )


def route_xdr() -> str:
    return scval.to_vec(
        [
            scval.to_vec(
                [
                    scval.to_vec(
                        [scval.to_address(SELL_TOKEN), scval.to_address(BUY_TOKEN)]
                    ),
                    scval.to_bytes(bytes([5]) * 32),
                    scval.to_address(BUY_TOKEN),
                ]
            )
        ]
    ).to_xdr()


def fill_receipt(order_id: str, reward_to: str, maker_delta: int = 950) -> xdr.SCVal:
    return scval.to_struct(
        {
            "order_id": scval.to_bytes(bytes.fromhex(order_id)),
            "router_output": scval.to_uint128(950),
            "maker_buy_delta_before_reward": scval.to_uint128(maker_delta),
            "reward_xlm": scval.to_uint128(5_000_000),
            "reward_to": scval.to_address(reward_to),
        }
    )


def test_registry_record_validates_canonical_body_and_detached_auth():
    payload, _ = detached_payload()
    record = parse_limit_order_record(
        payload,
        network_passphrase=NETWORK,
        settlement_address=SETTLEMENT,
        xlm_token=XLM_TOKEN,
    )

    assert record.order_id == payload["order_id"]
    assert record.order.required_router_min(XLM_TOKEN) == 900
    assert record.authorization is not None

    changed = dict(payload, sell_amount="1001")
    with pytest.raises(AquariusError, match="canonical order XDR"):
        parse_limit_order_record(
            changed,
            network_passphrase=NETWORK,
            settlement_address=SETTLEMENT,
            xlm_token=XLM_TOKEN,
        )


def test_contract_onchain_record_requires_confirmed_placement():
    payload, _ = detached_payload()
    maker = contract(6)
    order = order_scval(maker, "ContractOnChain")
    payload.update(
        {
            "order_id": hashlib.sha256(order.to_xdr_bytes()).hexdigest(),
            "placement_mode": "CONTRACT_ONCHAIN",
            "maker": maker,
            "order_xdr": order.to_xdr(),
            "authorization_xdr": "",
        }
    )
    with pytest.raises(AquariusError, match="placement reference"):
        parse_limit_order_record(
            payload,
            network_passphrase=NETWORK,
            settlement_address=SETTLEMENT,
            xlm_token=XLM_TOKEN,
        )

    payload.update(
        placement_ledger=101,
        placement_transaction_hash="ab" * 32,
    )
    record = parse_limit_order_record(
        payload,
        network_passphrase=NETWORK,
        settlement_address=SETTLEMENT,
        xlm_token=XLM_TOKEN,
    )
    assert record.authorization is None


def test_client_follows_registry_pages_and_rejects_duplicate_orders():
    payload, _ = detached_payload()
    client = AquariusClient(
        network="testnet",
        limit_orders=LimitOrderConfig(settlement=SETTLEMENT),
    )
    client.api.list_limit_orders = Mock(
        side_effect=[
            {"orders": [payload], "next_cursor": "next"},
            {"orders": [payload], "next_cursor": None},
        ]
    )

    with pytest.raises(AquariusError, match="repeated an order"):
        client.open_limit_orders()
    assert client.api.list_limit_orders.call_count == 2


def test_route_and_fill_receipt_preserve_contract_shape_and_maker_minimum():
    payload, maker = detached_payload()
    record = parse_limit_order_record(
        payload,
        network_passphrase=NETWORK,
        settlement_address=SETTLEMENT,
        xlm_token=XLM_TOKEN,
    )
    route = scval.to_native(route_scval_from_swap_chain(route_xdr()))
    assert route[0]["pool_index"] == bytes([5]) * 32
    assert [item.address for item in route[0]["pool_tokens"]] == [
        SELL_TOKEN,
        BUY_TOKEN,
    ]

    receipt = validate_fill_receipt(
        record,
        maker.public_key,
        fill_receipt(record.order_id, maker.public_key),
    )
    assert receipt.maker_buy_delta_before_reward == 950
    with pytest.raises(AquariusError, match="maker payout"):
        validate_fill_receipt(
            record,
            maker.public_key,
            fill_receipt(record.order_id, maker.public_key, maker_delta=899),
        )


def test_prepare_fill_attaches_auth_checks_fee_and_submits_through_engine():
    payload, filler = detached_payload()
    client = AquariusClient(
        network="testnet",
        signer=filler,
        limit_orders=LimitOrderConfig(settlement=SETTLEMENT),
        base_fee=1_000,
    )
    record = parse_limit_order_record(
        payload,
        network_passphrase=NETWORK,
        settlement_address=SETTLEMENT,
        xlm_token=XLM_TOKEN,
        client=client,
    )
    captured = []

    class Builder:
        def append_invoke_contract_function_op(self, **kwargs):
            captured.append(kwargs)
            return self

    client.engine.build_transaction = Mock(
        side_effect=lambda _source, append: append(Builder()) and SimpleNamespace()
    )
    client.server.simulate_transaction = Mock(
        return_value=SimpleNamespace(
            restore_preamble=None,
            error=None,
            results=[
                SimpleNamespace(
                    xdr=fill_receipt(record.order_id, filler.public_key).to_xdr()
                )
            ],
        )
    )
    prepared_tx = SimpleNamespace(
        transaction=SimpleNamespace(fee=4_999_999),
        to_xdr=lambda: "prepared-xdr",
    )
    client.server.prepare_transaction = Mock(return_value=prepared_tx)
    client.engine.sign_and_submit = Mock(
        return_value=SimpleNamespace(tx_hash="cd" * 32)
    )

    prepared = record.prepare_fill(route_xdr())
    assert prepared.maximum_fee == 4_999_999
    assert captured[-1]["contract_id"] == SETTLEMENT
    assert captured[-1]["function_name"] == "fill"
    assert captured[-1]["auth"] == [record.authorization]
    result = prepared.execute()
    assert result.tx_hash == "cd" * 32

    prepared_tx.transaction.fee = 5_000_000
    with pytest.raises(AquariusError, match="below execution fee"):
        record.prepare_fill(route_xdr())


def test_limit_order_route_lookup_is_separate_from_limit_policy():
    payload, filler = detached_payload()
    client = AquariusClient(
        network="testnet",
        signer=filler,
        limit_orders=LimitOrderConfig(settlement=SETTLEMENT),
    )
    record = parse_limit_order_record(
        payload,
        network_passphrase=NETWORK,
        settlement_address=SETTLEMENT,
        xlm_token=XLM_TOKEN,
        client=client,
    )
    client.api.find_path = Mock(
        return_value={
            "success": True,
            "amount": "950",
            "swap_chain_xdr": route_xdr(),
        }
    )
    quote = client.find_limit_order_route(record)
    assert quote.amount_out == 950
    assert quote.swap_chain_xdr == route_xdr()
    client.api.find_path.assert_called_once_with(
        {
            "token_in_address": SELL_TOKEN,
            "token_out_address": BUY_TOKEN,
            "amount": "1000",
        },
        exact_input=True,
    )
    client.api.find_path.return_value = {
        "success": True,
        "amount": "899",
        "swap_chain_xdr": route_xdr(),
    }
    below_limit = client.find_limit_order_route(record)
    assert below_limit.amount_out == 899
    assert below_limit.amount_out < record.required_router_min(XLM_TOKEN)

    client.api.find_path.return_value = {"success": False}
    with pytest.raises(NoRouteError, match="No route"):
        client.find_limit_order_route(record)


def test_record_cancel_requires_the_maker_and_uses_canonical_order():
    payload, maker = detached_payload()
    client = AquariusClient(
        network="testnet",
        signer=maker,
        limit_orders=LimitOrderConfig(settlement=SETTLEMENT),
    )
    record = parse_limit_order_record(
        payload,
        network_passphrase=NETWORK,
        settlement_address=SETTLEMENT,
        xlm_token=XLM_TOKEN,
        client=client,
    )
    captured = []

    class Builder:
        def append_invoke_contract_function_op(self, **kwargs):
            captured.append(kwargs)
            return self

    client.engine.prepare = Mock(
        side_effect=lambda _source, append, _signer: append(Builder())
        and SimpleNamespace()
    )
    client.engine.sign_and_submit = Mock(
        return_value=SimpleNamespace(tx_hash="ef" * 32)
    )

    assert record.cancel().tx_hash == "ef" * 32
    assert captured[-1]["parameters"] == [record.order.order_scval]

    other = AquariusClient(
        network="testnet",
        signer=Keypair.random(),
        limit_orders=LimitOrderConfig(settlement=SETTLEMENT),
    )
    with pytest.raises(AquariusError, match="maker"):
        other.cancel_limit_order(record)
