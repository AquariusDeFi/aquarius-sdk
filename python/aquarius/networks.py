from __future__ import annotations

from dataclasses import dataclass

from stellar_sdk import Asset, Network

from .ice import IceContracts


@dataclass(frozen=True)
class NetworkConfig:
    router: str
    api_url: str
    rpc_url: str
    horizon_url: str
    passphrase: str
    # A long-lived funded account used as the simulation source for signer-less
    # reads (simulations need an existing source account; the AQUA issuer is the
    # convention the documentation examples use).
    read_source: str
    # Provider-fee collector factory; set on both presets. A hand-built config
    # may leave it None — pass factory= explicitly to deploy_fee_collector then.
    collector_factory: str | None = None
    limit_orders_api_url: str | None = None
    ice_contracts: IceContracts | None = None


NETWORKS: dict[str, NetworkConfig] = {
    "mainnet": NetworkConfig(
        router="CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
        api_url="https://amm-api.aqua.network/api/external/v2",
        # The protocol's own RPC — the same endpoint the Aquarius web app and
        # backend run on. Override with rpc_url= to bring your own node.
        rpc_url="https://soroban-rpc.aqua.network",
        horizon_url="https://horizon.stellar.org",
        passphrase=Network.PUBLIC_NETWORK_PASSPHRASE,
        read_source="GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA",
        collector_factory="CA4Q2T6FRAFYJYSMDJV7F6B7RL5PS6QS2UOZHBMCT2KSMGQRAAKP2MKO",
        limit_orders_api_url="https://amm-api.aqua.network/api/external/v1/limit-orders",
        ice_contracts=IceContracts(
            locker="CCF3BZBCEMCOXJITDPF73QAUFYMXD5DSGWIUFZW4U7Q3DLKD3K3CLZ7N",
            aqua_token=Asset("AQUA", "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA").contract_id(Network.PUBLIC_NETWORK_PASSPHRASE),
            ice="CCVNQAKX6JTJVQKOMSEYPW5RAZRWDKSFWEAWCCV5IFPOUQ4VVL2GPDZS",
            upvote="CCRSZNKO4F3H45B6NPZE2ILXTUP3UAM7PSCNAKLAJO63OYGE2U557UCU",
            govern="CDSOORDHX7T4O7MN2OYUFH2ISZC2QJF7WM3KPG7VYVXUD4A5V2STV6ST",
        ),
    ),
    "testnet": NetworkConfig(
        router="CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD",
        api_url="https://amm-api-testnet.aqua.network/api/external/v2",
        rpc_url="https://soroban-testnet.stellar.org:443",
        horizon_url="https://horizon-testnet.stellar.org",
        passphrase=Network.TESTNET_NETWORK_PASSPHRASE,
        read_source="GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER",
        collector_factory="CCXU6S2PFFFESV65RHUEVJX6TSSN6BYKOCJ3S3LM5M3IXXIWAL5AV4CO",
        limit_orders_api_url="https://amm-api-testnet.aqua.network/api/external/v1/limit-orders",
        ice_contracts=IceContracts(
            locker="CAU5JTZ5D3TUK53WOTT5UO75U6IYAFXSGCEWJJYVIAEJJ4N5AVM72DZV",
            aqua_token=Asset("AQUA", "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER").contract_id(Network.TESTNET_NETWORK_PASSPHRASE),
            ice="CASSMR4PXHFA6JLEUCULKLOY4BXGPMTGEYSLLDGF6EQCZOGVNRLF5YTY",
            upvote="CAACTYVX4DRXV7HDZ4XGIVMBUQV5VVAWEFNL5YBH7QRUAVGIG4SDOB3K",
            govern="CAV4FLWRQ4I4Q2LBY4QIPL6HNJFFNLLQNBYSKA5FAILZYG4K3FDFNN7D",
        ),
    ),
}
