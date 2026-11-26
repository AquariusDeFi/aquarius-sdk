"""Swaps that pay the signer a classic asset other than XLM, which the signer
does not issue, authorize the asset's trust(signer) under the swap root, before
the input is pulled. The contract opens a missing trustline with it."""
import json
import pathlib
from types import SimpleNamespace

import pytest
from stellar_sdk import Address, Keypair, StrKey, scval

from aquarius import XLM, AquariusClient, Asset, ProviderFeeConfig, SlippageError
from aquarius.pool import Pool, sort_token_ids
from aquarius.submit import ConfirmedTx

TESTDATA = pathlib.Path(__file__).resolve().parents[2] / "testdata"
CHAIN = json.loads((TESTDATA / "find_path_testnet_xlm_aqua.json").read_text())
SPLIT = json.loads((TESTDATA / "split-plans.json").read_text())
PASSPHRASE = "Test SDF Network ; September 2015"
ISSUER = "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER"
AQUA = Asset.classic("AQUA", ISSUER)
XLM_ID = XLM.contract_id(PASSPHRASE)
AQUA_ID = AQUA.contract_id(PASSPHRASE)
COLLECTOR_ID = StrKey.encode_contract(b"\x11" * 32)
POOL_ID = StrKey.encode_contract(b"\x22" * 32)


class AccountSigner:
    def __init__(self, public_key):
        self.public_key = public_key


class RecordingBuilder:
    def append_invoke_contract_function_op(self, **kwargs):
        self.root = kwargs["auth"][0].root_invocation
        return self

    def append_operation(self, operation):
        self.root = operation.auth[0].root_invocation
        return self


def make_client(signer=None):
    """A testnet client that captures every swap's root invocation at
    preparation and confirms it with output 1."""
    client = AquariusClient(network="testnet", signer=signer or Keypair.random())
    client.roots = []

    def prepare(source, append, signer=None):
        builder = RecordingBuilder()
        append(builder)
        client.roots.append(builder.root)
        return SimpleNamespace(to_xdr=lambda: "unsigned-xdr")

    def submit_router(fn, args, *, auth):
        client.roots.append(auth[0].root_invocation)
        return ConfirmedTx(tx_hash="hash", return_value=scval.to_uint128(1))

    def no_lookup(keys):
        raise AssertionError("a swap does not look up the account's trustlines")

    client.server.get_ledger_entries = no_lookup
    client.api.find_path = lambda request, exact_input: CHAIN
    client.api.find_path_split = lambda request: SPLIT["plans"]["single"]["response"]
    client.engine.prepare = prepare
    client.engine.sign_and_submit = lambda tx, signer: ConfirmedTx(
        tx_hash="hash", return_value=scval.to_uint128(1)
    )
    client._read_router = lambda fn, args: scval.to_uint128(1_000)
    client._submit_router = submit_router
    return client


def pool(client):
    return Pool(
        address=POOL_ID, pool_hash=bytes(32), type="volatile", fee_bps=30,
        tokens=sort_token_ids([XLM_ID, AQUA_ID]), token_labels=[], _client=client,
    )


# Each entry point swaps into `to` and leaves the root invocation in client.roots.
PATHS = {
    "quote exact-in execute": lambda client, frm, to: client.quote(frm, to, amount_in=100_000_000).execute(),
    "quote exact-out build": lambda client, frm, to: client.quote(frm, to, amount_out=100_000_000).build_transaction(),
    "swap split": lambda client, frm, to: client.swap(frm, to, amount_in=int(SPLIT["request"]["amount"])),
    "pool swap": lambda client, frm, to: pool(client).swap(frm, to, amount_in=500),
}
FIRST_CALL = {
    "quote exact-in execute": (XLM_ID, "transfer"),
    "quote exact-out build": (XLM_ID, "transfer"),
    "swap split": (XLM_ID, "transfer"),
    "pool swap": (POOL_ID, "swap"),
}
# The split fixture only has plans from XLM to AQUA.
NON_SPLIT = [name for name in PATHS if name != "swap split"]


def fn_name(invocation):
    return invocation.function.contract_fn.function_name.sc_symbol.decode()


def contract(invocation):
    return Address.from_xdr_sc_address(invocation.function.contract_fn.contract_address).address


def calls(root):
    return [(contract(sub), fn_name(sub)) for sub in root.sub_invocations]


@pytest.mark.parametrize("name", PATHS)
def test_a_classic_output_authorizes_trust_before_the_input(name):
    signer = Keypair.random()
    client = make_client(signer)
    PATHS[name](client, XLM, AQUA)

    [root] = client.roots
    assert calls(root) == [(AQUA_ID, "trust"), FIRST_CALL[name]]
    trust = root.sub_invocations[0].function.contract_fn
    assert [scval.from_address(arg).address for arg in trust.args] == [signer.public_key]


@pytest.mark.parametrize("name", NON_SPLIT)
def test_xlm_output_gets_no_trust(name):
    client = make_client()
    PATHS[name](client, AQUA, XLM)

    [root] = client.roots
    assert "trust" not in [fn for _, fn in calls(root)]


@pytest.mark.parametrize("name", PATHS)
def test_the_issuer_gets_no_trust(name):
    client = make_client(AccountSigner(ISSUER))
    PATHS[name](client, XLM, AQUA)

    [root] = client.roots
    assert calls(root) == [FIRST_CALL[name]]


@pytest.mark.parametrize("name", PATHS)
def test_a_token_known_by_contract_id_gets_no_trust(name):
    client = make_client()
    PATHS[name](client, XLM, Asset.contract(AQUA_ID))
    if name == "pool swap":
        PATHS[name](client, XLM_ID, AQUA_ID)

    assert client.roots
    for root in client.roots:
        assert calls(root) == [FIRST_CALL[name]]


def provider_quote(client, exact_input, recipient=None):
    fee = ProviderFeeConfig(COLLECTOR_ID, 30, 10_000, recipient=recipient)
    amount = {"amount_in" if exact_input else "amount_out": 100_000_000}
    return client.quote(XLM, AQUA, provider_fee=fee, **amount)


@pytest.mark.parametrize("exact_input", [True, False])
@pytest.mark.parametrize("to_signer_explicitly", [False, True])
def test_a_provider_fee_paying_the_signer_authorizes_trust(exact_input, to_signer_explicitly):
    signer = Keypair.random()
    client = make_client(signer)
    recipient = signer.public_key if to_signer_explicitly else None
    provider_quote(client, exact_input, recipient).execute()

    [root] = client.roots
    assert contract(root) == COLLECTOR_ID
    assert calls(root) == [(AQUA_ID, "trust"), (XLM_ID, "transfer")]
    transfer = root.sub_invocations[1].function.contract_fn
    assert scval.from_address(transfer.args[1]).address == COLLECTOR_ID


@pytest.mark.parametrize("exact_input", [True, False])
def test_a_provider_fee_paying_another_recipient_gets_no_trust(exact_input):
    client = make_client()
    provider_quote(client, exact_input, Keypair.random().public_key).build_transaction()

    [root] = client.roots
    assert fn_name(root).endswith("_to")
    assert calls(root) == [(XLM_ID, "transfer")]


def test_a_pool_requote_keeps_the_output_as_named():
    client = make_client()
    submit_router = client._submit_router

    def slipping_once(fn, args, *, auth):
        if not client.roots:
            client.roots.append(auth[0].root_invocation)
            raise SlippageError("guard breached")
        return submit_router(fn, args, auth=auth)

    client._submit_router = slipping_once
    with pytest.raises(SlippageError) as caught:
        pool(client).quote(XLM, AQUA, amount_in=500).execute()
    requoted = caught.value.requote()
    assert requoted._to == AQUA
    requoted.execute()
    assert [calls(root) for root in client.roots] == [[(AQUA_ID, "trust"), (POOL_ID, "swap")]] * 2
