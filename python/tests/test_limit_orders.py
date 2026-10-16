import copy
import json
import pathlib
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from stellar_sdk import Address, Network, StrKey, scval, xdr

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
# Mainnet's max_entry_ttl: a network max TTL of 3,110,399 ledgers.
MAX_ENTRY_TTL = 3_110_400


def native(value):
    if isinstance(value, Address):
        return value.address
    if isinstance(value, list):
        return [native(item) for item in value]
    return value


def archival_settings(max_entry_ttl):
    u32 = xdr.Uint32
    entry = xdr.LedgerEntryData(
        type=xdr.LedgerEntryType.CONFIG_SETTING,
        config_setting=xdr.ConfigSettingEntry(
            config_setting_id=xdr.ConfigSettingID.CONFIG_SETTING_STATE_ARCHIVAL,
            state_archival_settings=xdr.StateArchivalSettings(
                max_entry_ttl=u32(max_entry_ttl),
                min_temporary_ttl=u32(17_280),
                min_persistent_ttl=u32(2_073_600),
                persistent_rent_rate_denominator=xdr.Int64(1_215),
                temp_rent_rate_denominator=xdr.Int64(2_430),
                max_entries_to_archive=u32(1_000),
                live_soroban_state_size_window_sample_size=u32(30),
                live_soroban_state_size_window_sample_period=u32(64),
                eviction_scan_size=u32(100_000),
                starting_eviction_scan_level=u32(7),
            ),
        ),
    )
    return SimpleNamespace(entries=[SimpleNamespace(xdr=entry.to_xdr())])


def on_network(client, *, current_ledger=100, max_entry_ttl=MAX_ENTRY_TTL):
    client.server.get_health = Mock(
        return_value=SimpleNamespace(latest_ledger=current_ledger)
    )
    client.server.get_ledger_entries = Mock(
        return_value=archival_settings(max_entry_ttl)
    )
    client._network_max_ttl_cache = None
    return client


def settlement_reads(client, *, executor_reward=5_000_000, allowance=None):
    """Answer get_executor_reward from the configured settlement; other reads
    return ``allowance``, or go through the RPC when it is None."""
    read = client._read_contract

    def fake(contract_id, fn, args, **kwargs):
        if fn == "get_executor_reward":
            assert contract_id == client.limit_order_config.settlement
            return scval.to_uint128(executor_reward)
        if allowance is None:
            return read(contract_id, fn, args, **kwargs)
        return scval.to_int128(allowance)

    client._read_contract = Mock(side_effect=fake)
    client._executor_reward_cache = None
    return client


def validate(payload=None, max_live_until_ledger=250, executor_reward=5_000_000):
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
        max_live_until_ledger=max_live_until_ledger,
        expected_executor_reward_xlm=executor_reward,
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
            max_live_until_ledger=250,
            expected_executor_reward_xlm=5_000_000,
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
    settlement_reads(on_network(client), allowance=0)
    client.server.get_latest_ledger = Mock(side_effect=AssertionError("getLatestLedger"))
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


def onchain_client():
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
    return settlement_reads(client, allowance=0)


def create(client, *, valid_after_ledger=100, expires_at_ledger=200, allowance_expiration_ledger=250):
    return client.create_onchain_limit_order(
        Asset.contract(DRAFT["sell_token"]),
        Asset.contract(DRAFT["buy_token"]),
        sell_amount=1_000,
        min_buy_amount=900,
        valid_after_ledger=valid_after_ledger,
        expires_at_ledger=expires_at_ledger,
        allowance_expiration_ledger=allowance_expiration_ledger,
    )


def test_network_max_ttl_is_max_entry_ttl_minus_one_and_cached():
    client = on_network(onchain_client())
    assert client.network_max_ttl() == 3_110_399
    assert client.network_max_ttl() == 3_110_399
    client.server.get_ledger_entries.assert_called_once()
    (key,), = client.server.get_ledger_entries.call_args.args
    assert key.config_setting.config_setting_id == xdr.ConfigSettingID.CONFIG_SETTING_STATE_ARCHIVAL


def test_draft_lifetime_is_capped_at_current_ledger_plus_network_max_ttl():
    # current ledger 100 and max TTL 150: nothing may expire after ledger 250
    client = on_network(onchain_client(), current_ledger=100, max_entry_ttl=151)
    client.api.create_limit_order_draft = Mock(return_value=DRAFT)
    assert create(client, allowance_expiration_ledger=250).order_id == DRAFT["order_id"]

    with pytest.raises(AquariusError, match="limit-order expiration ledger 251 is beyond the network limit 250"):
        create(client, expires_at_ledger=251, allowance_expiration_ledger=251)
    with pytest.raises(AquariusError, match="limit-order expiration ledger 251"):
        create(client, valid_after_ledger=200, expires_at_ledger=251, allowance_expiration_ledger=251)
    with pytest.raises(AquariusError, match="allowance expiration ledger 251 is beyond the network limit 250"):
        create(client, allowance_expiration_ledger=251)
    client.api.create_limit_order_draft.assert_called_once()


def test_draft_validation_rejects_lifetimes_beyond_the_given_network_limit():
    assert validate(max_live_until_ledger=250).allowance_expiration_ledger == 250
    with pytest.raises(AquariusError, match="allowance expiration ledger 250"):
        validate(max_live_until_ledger=249)
    with pytest.raises(AquariusError, match="limit-order expiration ledger 200"):
        validate(max_live_until_ledger=199)
    with pytest.raises(AquariusError, match="max_live_until_ledger"):
        validate(max_live_until_ledger=None)


def test_placement_rechecks_the_network_limit_before_building():
    client = on_network(onchain_client(), current_ledger=100, max_entry_ttl=150)
    order = replace(validate(), _client=client)
    client._read_contract = Mock(side_effect=AssertionError("must not read allowances"))
    client.engine.prepare = Mock(side_effect=AssertionError("must not build"))
    client.engine.sign_and_submit = Mock(side_effect=AssertionError("must not submit"))
    for build in [order.build_transaction, order.place]:
        with pytest.raises(AquariusError, match="allowance expiration ledger 250 is beyond the network limit 249"):
            build()


@pytest.mark.parametrize("response", [
    SimpleNamespace(entries=[]),
    RuntimeError("rpc unavailable"),
])
def test_network_limit_read_failure_fails_closed(response):
    client = on_network(onchain_client())
    client.server.get_ledger_entries = Mock(side_effect=[response])
    client.api.create_limit_order_draft = Mock(side_effect=AssertionError("must not request a draft"))
    with pytest.raises((AquariusError, RuntimeError), match="STATE_ARCHIVAL|rpc unavailable"):
        create(client)
    client.api.create_limit_order_draft.assert_not_called()


def test_draft_executor_reward_must_match_the_settlement_contract():
    client = on_network(onchain_client())
    client.api.create_limit_order_draft = Mock(return_value=DRAFT)
    assert create(client).executor_reward_xlm == 5_000_000
    assert create(client).executor_reward_xlm == 5_000_000
    reward_reads = [
        call for call in client._read_contract.call_args_list
        if call.args[1] == "get_executor_reward"
    ]
    assert len(reward_reads) == 1

    settlement_reads(client, executor_reward=4_000_000)
    with pytest.raises(AquariusError, match="executor reward 5000000 does not match the settlement contract's 4000000"):
        create(client)

    with pytest.raises(AquariusError, match="executor reward 5000000 does not match"):
        validate(executor_reward=4_999_999)
    with pytest.raises(AquariusError, match="expected_executor_reward_xlm"):
        validate(executor_reward=None)


def test_placement_rejects_an_inflated_reward_and_approves_the_verified_one():
    client = on_network(onchain_client())
    client.engine.sign_and_submit = Mock(side_effect=AssertionError("must not submit"))
    client.engine.prepare = Mock(side_effect=AssertionError("must not build"))
    inflated = replace(validate(), executor_reward_xlm=50_000_000, _client=client)
    for build in [inflated.build_transaction, inflated.place]:
        with pytest.raises(AquariusError, match="executor reward 50000000 does not match the settlement contract's 5000000"):
            build()

    captured = []

    class Builder:
        def append_invoke_contract_function_op(self, **kwargs):
            captured.append(kwargs)
            return self

    def prepare(_source, append, _signer=None):
        append(Builder())
        return SimpleNamespace(to_xdr=lambda: "unsigned-xdr")

    client.engine.prepare = prepare
    assert replace(validate(), _client=client).build_transaction() == "unsigned-xdr"
    calls = native(scval.to_native(captured[-1]["parameters"][1]))
    xlm = Asset.native().contract_id(client.network.passphrase)
    assert calls[1] == [
        xlm,
        "approve",
        [DRAFT["maker"], DRAFT["settlement_address"], 5_000_000, 250],
    ]


@pytest.mark.parametrize("read,message", [
    (Mock(side_effect=AquariusError("simulation failed")), "simulation failed"),
    (Mock(return_value=scval.to_int128(5_000_000)), "invalid value"),
])
def test_executor_reward_read_failure_fails_closed(read, message):
    client = on_network(onchain_client())
    client._read_contract = read
    client.api.create_limit_order_draft = Mock(side_effect=AssertionError("must not request a draft"))
    with pytest.raises(AquariusError, match=message):
        create(client)


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
    order = replace(validate(), _client=on_network(client))
    settlement_reads(client, allowance=0)
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
    order = replace(validate(), _client=settlement_reads(on_network(client)))
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
