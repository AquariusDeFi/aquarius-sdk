import { Networks } from "@stellar/stellar-sdk";

export interface NetworkConfig {
  router: string;
  /** Batch contract: several calls under one signature (see batch.ts). */
  batch: string;
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
  /**
   * Provider-fee collector factory; set on both presets. A hand-built config
   * may omit it — pass `factory` explicitly to `deployFeeCollector` then.
   */
  collectorFactory?: string;
  /** The protocol reward token (AQUA) — code and issuer of the classic asset. */
  rewardToken: { code: string; issuer: string };
  limitOrdersApiUrl?: string;
  /** ICE Locker: locks AQUA (the reward token) until an unlock time. Set on testnet only. */
  locker?: string;
  /** upvoteICE delegation proxy. Set on testnet only. */
  upvoteIceProxy?: string;
  /** governICE delegation proxy. Set on testnet only. */
  governIceProxy?: string;
}

export const NETWORKS: Record<"mainnet" | "testnet", NetworkConfig> = {
  mainnet: {
    router: "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
    batch: "CBZX5A64HWVYXGGXSSWGYZZTUYFNGVKLAESK3XOZDJXYKLOY7MTCFAEV",
    apiUrl: "https://amm-api.aqua.network/api/external/v2",
    // The protocol's own RPC — the same endpoint the Aquarius web app and
    // backend run on. Override with rpcUrl to bring your own node.
    rpcUrl: "https://soroban-rpc.aqua.network",
    horizonUrl: "https://horizon.stellar.org",
    passphrase: Networks.PUBLIC,
    readSource: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA",
    collectorFactory: "CA4Q2T6FRAFYJYSMDJV7F6B7RL5PS6QS2UOZHBMCT2KSMGQRAAKP2MKO",
    rewardToken: { code: "AQUA", issuer: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA" },
    limitOrdersApiUrl: "https://amm-api.aqua.network/api/external/v1/limit-orders",
  },
  testnet: {
    router: "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD",
    batch: "CCNMIX72UQIM44MB4T3LIKIMADPFBNIBVHTX27QTFLB6IACJLRWM6PA4",
    apiUrl: "https://amm-api-testnet.aqua.network/api/external/v2",
    rpcUrl: "https://soroban-testnet.stellar.org:443",
    horizonUrl: "https://horizon-testnet.stellar.org",
    passphrase: Networks.TESTNET,
    readSource: "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER",
    collectorFactory: "CCXU6S2PFFFESV65RHUEVJX6TSSN6BYKOCJ3S3LM5M3IXXIWAL5AV4CO",
    rewardToken: { code: "AQUA", issuer: "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER" },
    limitOrdersApiUrl: "https://amm-api-testnet.aqua.network/api/external/v1/limit-orders",
    locker: "CAU5JTZ5D3TUK53WOTT5UO75U6IYAFXSGCEWJJYVIAEJJ4N5AVM72DZV",
    upvoteIceProxy: "CAACTYVX4DRXV7HDZ4XGIVMBUQV5VVAWEFNL5YBH7QRUAVGIG4SDOB3K",
    governIceProxy: "CAV4FLWRQ4I4Q2LBY4QIPL6HNJFFNLLQNBYSKA5FAILZYG4K3FDFNN7D",
  },
};
