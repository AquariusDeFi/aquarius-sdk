// End-to-end demo: two real swaps on testnet with a throwaway account.
// Run: npm run build && node examples/demo.mjs
import { Keypair } from "@stellar/stellar-sdk";

import { AquariusClient, Asset, XLM } from "../dist/index.js";

const AQUA = Asset.classic("AQUA", "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER");

const aqua = new AquariusClient({ network: "testnet", signer: Keypair.random() });
await aqua.fundWithFriendbot();
await aqua.ensureTrustline(AQUA);

// exact input: swap 10 XLM
let quote = await aqua.quote({ from: XLM, to: AQUA, amountIn: 100_000_000n });
console.log(
  `quote:   10 XLM -> ${Number(quote.amountOut) / 1e7} AQUA via ${quote.route.length} pool(s), ` +
    `guaranteed >= ${Number(quote.guard) / 1e7}`,
);
let receipt = await quote.execute();
console.log(`swapped: received ${Number(receipt.amountOut) / 1e7} AQUA`);
console.log(`         https://stellar.expert/explorer/testnet/tx/${receipt.txHash}`);

// exact output: receive exactly 100 AQUA — swap() re-quotes and retries
// up to twice if the pool moves past the guard in between
receipt = await aqua.swap({ from: XLM, to: AQUA, amountOut: 100_0000000n, retries: 2 });
console.log(`swapped: paid ${Number(receipt.amountIn) / 1e7} XLM for exactly 100 AQUA`);
console.log(`         https://stellar.expert/explorer/testnet/tx/${receipt.txHash}`);
