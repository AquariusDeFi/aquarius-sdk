from __future__ import annotations

from dataclasses import dataclass

from stellar_sdk import Network


@dataclass(frozen=True)
class NetworkConfig:
    router: str
    api_url: str
    rpc_url: str
    horizon_url: str
    passphrase: str


NETWORKS: dict[str, NetworkConfig] = {
    "mainnet": NetworkConfig(
        router="CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
        api_url="https://amm-api.aqua.network/api/external/v2",
        rpc_url="https://mainnet.sorobanrpc.com",
        horizon_url="https://horizon.stellar.org",
        passphrase=Network.PUBLIC_NETWORK_PASSPHRASE,
    ),
    "testnet": NetworkConfig(
        router="CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD",
        api_url="https://amm-api-testnet.aqua.network/api/external/v2",
        rpc_url="https://soroban-testnet.stellar.org:443",
        horizon_url="https://horizon-testnet.stellar.org",
        passphrase=Network.TESTNET_NETWORK_PASSPHRASE,
    ),
}
