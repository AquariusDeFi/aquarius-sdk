# @aquariusdefi/sdk

The TypeScript SDK for [Aquarius](https://aqua.network) — swaps, liquidity, and rewards on Stellar.

**Status: 0.3.x — swaps, provider-fee collectors, and the liquidity lifecycle are available.** Concentrated liquidity position management is not covered yet. The API may still change before 1.0.

```bash
npm install @aquariusdefi/sdk
```

```ts
import { Keypair } from "@stellar/stellar-sdk";
import { AquariusClient, Asset, XLM, SlippageError } from "@aquariusdefi/sdk";

const AQUA = Asset.classic("AQUA", "GBNZ...AQUA");

const aqua = new AquariusClient({ network: "mainnet", signer: Keypair.fromSecret(secret) });

// exact input: quote, show the user, execute
const quote = await aqua.quote({ from: XLM, to: AQUA, amountIn: 100_0000000n, slippage: 0.01 });
const receipt = await quote.execute();

// exact output: pass amountOut instead — strict-receive throughout
await aqua.quote({ from: XLM, to: AQUA, amountOut: 500_0000000n });
```

## Provider fees

Pass the collector configuration with the quote. The SDK keeps the fee math exact, routes through the collector, and sends output to `recipient` without requiring that address to sign:

```ts
const quote = await aqua.quote({
  from: XLM,
  to: AQUA,
  amountIn: 100_0000000n,
  slippage: 0.005,
  providerFee: {
    contractId: "C...",
    feeFraction: 30,
    feeDenominator: 10_000,
    recipient: "G...",
  },
});
const receipt = await quote.execute();
```

Omit `recipient` to send output back to the signer through the collector's legacy swap methods. Use `amountOut` instead of `amountIn` for an exact-output provider swap.

## Liquidity

```ts
const pools = await aqua.pools.forPair(XLM, AQUA);   // discovered on-chain, sorted by type and fee
const pool = pools[0];                                // type "volatile", feeBps 10, ...

const result = await pool.deposit({ amounts: [[XLM, 50_0000000n], [AQUA, 2500_0000000n]] });
console.log(result.shares);                           // pool share tokens minted

await pool.pendingRewards();                          // accrued AQUA, in stroops
await pool.claimRewards();
await pool.withdraw({ shares: result.shares });

await aqua.positions();                               // every pool where the signer holds shares
```

Deposit and withdrawal guards come from a simulation of the exact call, reduced by `slippage` — quoted-versus-executed drift is bounded the same way as for swaps. Reads need no signer.

## What the SDK handles for you

- **Routing** — quotes come from the find-path API; the swap chain XDR is passed through untouched.
- **Transaction lifecycle** — simulation, assembly, submission with congestion retries (same-hash resubmission with backoff), and confirmation polling. Results come from the RPC return value; no transaction-meta parsing anywhere.
- **Archived state** — if simulation reports expired ledger entries, the SDK restores them (one extra signed transaction) and retries automatically.
- **Bounded approvals** — the router call and its token transfer are explicitly authorized with exact amounts, so wallets can display what the user is approving. For exact-output swaps the authorized transfer is the maximum input; the contract refunds the difference.
- **Typed errors** — `SlippageError` (with `requote()`), `PausedError` (kill switches — not your bug), `NoRouteError`, `UserRejectedError`, `TxTimeoutError`.

## Signers

Anything with `publicKey()` plus either `secret()` (a stellar-sdk `Keypair`) or `sign(xdr)` (wallet adapters). Reads — `quote()` — need no signer at all.

## Escape hatches

`quote.buildTransaction()` returns the simulated, unsigned envelope XDR for external signing flows (multisig, custom pipelines). `client.contract.call(fn, ...scVals)` invokes the router raw. `client.api` is the typed REST client.

## Amounts

All amounts are `bigint` in token base units (stroops for classic assets: 1 token = 10^7).

Questions and integration help: [Discord](https://discord.gg/sgzFscHp4C).
