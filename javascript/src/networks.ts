import { Networks } from "@stellar/stellar-sdk";

export interface NetworkConfig {
  router: string;
  apiUrl: string;
  rpcUrl: string;
  horizonUrl: string;
  passphrase: string;
}

export const NETWORKS: Record<"mainnet" | "testnet", NetworkConfig> = {
  mainnet: {
    router: "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
    apiUrl: "https://amm-api.aqua.network/api/external/v2",
    rpcUrl: "https://mainnet.sorobanrpc.com",
    horizonUrl: "https://horizon.stellar.org",
    passphrase: Networks.PUBLIC,
  },
  testnet: {
    router: "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD",
    apiUrl: "https://amm-api-testnet.aqua.network/api/external/v2",
    rpcUrl: "https://soroban-testnet.stellar.org:443",
    horizonUrl: "https://horizon-testnet.stellar.org",
    passphrase: Networks.TESTNET,
  },
};
