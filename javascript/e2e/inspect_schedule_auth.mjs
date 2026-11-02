// Prints the authorization tree the RPC simulation returns for
// pool_gauge_schedule_reward on testnet, so the client-built tree can mirror it.
// Read-only: nothing is signed or submitted. Run from javascript/: npm run build && node e2e/inspect_schedule_auth.mjs
import { Address, Operation, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { AquariusClient, Asset, NETWORKS, XLM } from "../dist/index.js";

const net = NETWORKS.testnet;
const AQUA = Asset.classic("AQUA", "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER");
const user = net.readSource; // the AQUA issuer: unlimited AQUA, so the transfer simulates
const aqua = new AquariusClient({ network: "testnet" });

const pools = await aqua.pools.forPair(XLM, AQUA);
const pool = pools.find(p => p.type !== "concentrated") ?? pools[0];
const config = await aqua.incentives.config();
console.log("pool", pool.address, pool.type, "config", config);

const tps = 10_000_000n; // 1 AQUA/s -> well above the daily minimum
const args = [
  new Address(user).toScVal(),
  xdr.ScVal.scvVec(pool.tokens.map(t => new Address(t).toScVal())),
  xdr.ScVal.scvBytes(Buffer.from(pool.poolHash)),
  new Address(AQUA.contractId(net.passphrase)).toScVal(),
  nativeToScVal(tps, { type: "u128" }),
  nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 3600), { type: "u64" }),
  nativeToScVal(config.minDurationSeconds, { type: "u64" }),
  xdr.ScVal.scvVec([]),
];

const server = new rpc.Server(net.rpcUrl);
const account = await server.getAccount(user);
const tx = new (await import("@stellar/stellar-sdk")).TransactionBuilder(account, {
  fee: "100000",
  networkPassphrase: net.passphrase,
})
  .addOperation(Operation.invokeContractFunction({ contract: net.router, function: "pool_gauge_schedule_reward", args }))
  .setTimeout(300)
  .build();

const sim = await server.simulateTransaction(tx);
if (rpc.Api.isSimulationError(sim)) {
  console.error("simulation error:", sim.error);
  process.exit(1);
}
const describe = (inv, depth = 0) => {
  const fn = inv.function.contractFn;
  const pad = "  ".repeat(depth);
  console.log(`${pad}${Address.fromScAddress(fn.contractAddress).toString()}.${fn.functionName.toString()}(`);
  for (const a of fn.args) console.log(`${pad}  ${JSON.stringify(scValToNative(a), (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  console.log(`${pad})`);
  for (const sub of inv.subInvocations) describe(sub, depth + 1);
};
for (const entry of sim.result?.auth ?? []) {
  console.log("credentials:", entry.credentials.type);
  describe(entry.rootInvocation);
}
console.log("retval:", JSON.stringify(scValToNative(sim.result.retval), (_, v) => (typeof v === "bigint" ? v.toString() : v)));
