import json
from pathlib import Path

from stellar_sdk import Asset, Network

from aquarius import parse_limit_order_record


def test_shared_auto_trust_and_legacy_vector_preserve_canonical_order():
    vector = json.loads(
        (Path(__file__).parents[2] / "testdata/limit_order_auto_trust.json").read_text()
    )
    for proof in ["authorization_xdr", "legacy_authorization_xdr"]:
        record = parse_limit_order_record(
            {**vector, "authorization_xdr": vector[proof]},
            network_passphrase=Network.TESTNET_NETWORK_PASSPHRASE,
            settlement_address=vector["settlement_address"],
            xlm_token=Asset.native().contract_id(Network.TESTNET_NETWORK_PASSPHRASE),
        )
        assert (
            record.order_id
            == "deb93819e99e5863c9d179da91d395699b01dccf0e88869c0d6353e76c9f1f28"
        )
