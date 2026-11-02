"""Cross-language wire fixtures and local ephemeral signing; no public network calls."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from stellar_sdk import Account, Address, Keypair, TransactionBuilder, TransactionEnvelope, scval, xdr
from stellar_sdk.auth import authorize_entry, authorization_payload_hash, build_authorization_preimage
from stellar_sdk.soroban_rpc import EventInfo

from aquarius.authorization import authorized_invocation, source_account_entry
from aquarius.signer import sign_transaction
from aquarius.submit import SubmitEngine

FIXTURE = json.loads((Path(__file__).parents[2] / "testdata/protocol_30.json").read_text())
PASSPHRASE = FIXTURE["network_passphrase"]
MUXED = next(a for a in FIXTURE["addresses"] if a["name"] == "muxed_contract")
CONTRACT = next(a for a in FIXTURE["addresses"] if a["name"] == "contract")


@pytest.mark.parametrize("entry", FIXTURE["addresses"], ids=lambda e: e["name"])
def test_old_and_muxed_contract_addresses(entry):
    address = xdr.SCAddress.from_xdr(entry["sc_address_xdr"])
    value = xdr.SCVal.from_xdr(entry["sc_val_xdr"])
    assert Address.from_xdr_sc_address(address).address == entry["address"]
    assert scval.to_native(value).address == entry["address"]
    assert Address(entry["address"]).to_xdr_sc_val().to_xdr() == entry["sc_val_xdr"]
    if entry["name"] == "muxed_contract":
        assert address.muxed_contract.id.uint64 == int(FIXTURE["muxed_contract_id"])


@pytest.mark.parametrize("entry", FIXTURE["stellar_values"], ids=lambda e: e["name"])
def test_stellar_value_variants(entry):
    value = xdr.StellarValue.from_xdr(entry["xdr"])
    assert value.ext.v.value == entry["extension"]
    assert value.close_time.time_point.uint64 == int(entry["close_time"])
    if entry["close_time_ms"]:
        payload = value.ext.signed_ms_value or value.ext.proposed_ms_value
        assert payload.close_time_ms.time_point_ms.uint64 == int(entry["close_time_ms"])
    assert value.to_xdr() == entry["xdr"]


@pytest.mark.parametrize("entry", FIXTURE["ledger_headers"], ids=lambda e: e["name"])
def test_nested_ledger_header_variants(entry):
    header = xdr.LedgerHeader.from_xdr(entry["xdr"])
    assert header.ledger_version.uint32 == entry["protocol_version"]
    assert header.scp_value.ext.v.value == entry["extension"]
    assert header.to_xdr() == entry["xdr"]


@pytest.mark.parametrize("entry", FIXTURE["envelopes"], ids=lambda e: e["name"])
def test_envelopes_and_signatures(entry):
    tx = TransactionEnvelope.from_xdr(entry["xdr"], PASSPHRASE)
    assert tx.hash_hex() == entry["hash"]
    assert tx.transaction.sequence == int(entry["sequence"])
    Keypair.from_public_key(entry["source"]).verify(tx.hash(), tx.signatures[0].signature)
    assert tx.to_xdr() == entry["xdr"]


@pytest.mark.parametrize("entry", FIXTURE["authorizations"], ids=lambda e: e["name"])
def test_authorization_signatures(entry):
    auth = xdr.SorobanAuthorizationEntry.from_xdr(entry["xdr"])
    payload = authorization_payload_hash(build_authorization_preimage(auth, entry["valid_until_ledger"], PASSPHRASE))
    assert payload.hex() == entry["payload_hash"]
    Keypair.from_public_key(entry["public_key"]).verify(payload, bytes.fromhex(entry["signature_hex"]))
    assert auth.to_xdr() == entry["xdr"]

    key = Keypair.random()
    credentials = auth.credentials.address or auth.credentials.address_v2 or auth.credentials.address_with_delegates.address_credentials
    credentials.address = Address(key.public_key).to_xdr_sc_address()
    credentials.signature = scval.to_void()
    signed = authorize_entry(auth, key, entry["valid_until_ledger"], PASSPHRASE)
    signed_credentials = signed.credentials.address or signed.credentials.address_v2 or signed.credentials.address_with_delegates.address_credentials
    signed_payload = authorization_payload_hash(build_authorization_preimage(signed, entry["valid_until_ledger"], PASSPHRASE))
    key.verify(signed_payload, scval.to_native(signed_credentials.signature)[0]["signature"])
    assert signed.root_invocation == auth.root_invocation


def test_rpc_v30_events_without_removed_success_flag():
    event = EventInfo.model_validate(FIXTURE["rpc_event"])
    assert scval.to_native(xdr.SCVal.from_xdr(event.value)).address == MUXED["address"]


@pytest.mark.parametrize("entry", FIXTURE["transaction_meta"], ids=lambda e: f"v{e['version']}")
def test_sdk_return_values_from_transaction_meta(entry):
    result = SimpleNamespace(result_meta_xdr=entry["xdr"])
    assert SubmitEngine._return_value(result).to_xdr() == entry["return_value_xdr"]


@pytest.mark.parametrize("wallet", [False, True], ids=["keypair", "wallet"])
def test_sdk_signing_preserves_source_account_auth(wallet):
    key = Keypair.random()
    args = [Address(MUXED["address"]).to_xdr_sc_val()]
    root = authorized_invocation(CONTRACT["address"], "compatibility", args)
    tx = (TransactionBuilder(Account(key.public_key, 100), PASSPHRASE, 100)
          .append_invoke_contract_function_op(CONTRACT["address"], "compatibility", args,
                                             auth=[source_account_entry(root)])
          .set_timeout(300).build())

    class Wallet:
        public_key = key.public_key

        def sign(self, envelope):
            signed = TransactionEnvelope.from_xdr(envelope, PASSPHRASE)
            signed.sign(key)
            return signed.to_xdr()

    signed = sign_transaction(Wallet() if wallet else key, tx, PASSPHRASE)
    key.verify(signed.hash(), signed.signatures[0].signature)
    auth = signed.transaction.operations[0].auth[0]
    assert auth.credentials.type == xdr.SorobanCredentialsType.SOROBAN_CREDENTIALS_SOURCE_ACCOUNT
    assert auth.root_invocation == root


def test_sdk_simulation_assembly_preserves_client_auth(monkeypatch):
    from stellar_sdk import SorobanServer
    from stellar_sdk.soroban_rpc import SimulateTransactionResponse

    key = Keypair.random()
    args = [Address(MUXED["address"]).to_xdr_sc_val()]
    entry = source_account_entry(authorized_invocation(CONTRACT["address"], "compatibility", args))
    simulation = SimulateTransactionResponse.model_validate(FIXTURE["rpc_simulation"])
    # Use the real SDK assembler, with all transports replaced by offline fixtures.
    with SorobanServer("https://rpc.invalid") as server:
        monkeypatch.setattr(server, "load_account", lambda source: Account(source, 100))
        monkeypatch.setattr(server, "simulate_transaction", lambda tx, **kwargs: simulation)
        engine = SubmitEngine(server, PASSPHRASE, 100, resource_fee_headroom=0, instruction_headroom=0)
        append = lambda builder: builder.append_invoke_contract_function_op(
            CONTRACT["address"], "compatibility", args, auth=[entry])
        tx = engine.prepare(key.public_key, append)
        assert tx.transaction.operations[0].auth[0] == entry
        assert tx.transaction.fee == 421
        assert scval.to_native(engine.read(key.public_key, append)).address == MUXED["address"]
