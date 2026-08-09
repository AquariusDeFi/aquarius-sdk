import { Networks } from "@stellar/stellar-sdk";

export interface NetworkConfig {
  router: string;
  apiUrl: string;
  rpcUrl: string;
  horizonUrl: string;
  passphrase: string;
  /**
   * A long-lived funded account used as the simulation source for signer-less
   * reads (simulations need an existing source account; the AQUA issuer is the
   * convention the documentation examples use).
   */
  readSource: string;
  /** Provider-fee collector factory; absent where not deployed (testnet). */
  collectorFactory?: string;
}

export const NETWORKS: Record<"mainnet" | "testnet", NetworkConfig> = {
  mainnet: {
    router: "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
    apiUrl: "https://amm-api.aqua.network/api/external/v2",
    // The protocol's own RPC — the same endpoint the Aquarius web app and
    // backend run on. Override with rpcUrl to bring your own node.
    rpcUrl: "https://soroban-rpc.aqua.network",
    horizonUrl: "https://horizon.stellar.org",
    passphrase: Networks.PUBLIC,
    readSource: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA",
    collectorFactory: "CA4Q2T6FRAFYJYSMDJV7F6B7RL5PS6QS2UOZHBMCT2KSMGQRAAKP2MKO",
  },
  testnet: {
    router: "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD",
    apiUrl: "https://amm-api-testnet.aqua.network/api/external/v2",
    rpcUrl: "https://soroban-testnet.stellar.org:443",
    horizonUrl: "https://horizon-testnet.stellar.org",
    passphrase: Networks.TESTNET,
    readSource: "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER",
  },
};
