# @aquariusdefi/sdk

The TypeScript SDK for [Aquarius](https://aqua.network) — swaps, liquidity, and rewards on Stellar.

**Status: 0.5.x — swaps and the liquidity lifecycle are complete and verified with real testnet transactions.** Concentrated liquidity position management is available as a beta surface (the contracts are under an ongoing external audit). The API may still change before 1.0.

## Swap through a specific pool

`aqua.quote()`/`swap()` route through the path-finding API. To pin a swap to
one pool you trust — your own routing, API independence — quote and swap on the
pool itself; the estimate comes from the router's on-chain `estimate_swap`:

```ts
const pool = (await aqua.pools.forPair(XLM, AQUA)).find(p => p.feeBps === 10)!;

const quote = await pool.quote({ from: XLM, to: AQUA, amountIn: 1_000_000_000n });
const receipt = await quote.execute();                 // swaps in this pool only
// or: await pool.swap({ from: XLM, to: AQUA, amountIn: 1_000_000_000n, retries: 3 });
```

Exact input only — the router has no single-pool strict-receive; for exact
output use `aqua.quote({ amountOut })`.

## Concentrated liquidity positions (beta)

A position is the key `(owner, tickLower, tickUpper)` on the pool contract — no
NFTs, merged on re-deposit, at most 20 ranges per account. Quotes come from the
contract's own estimators; `execute`/`withdrawPosition` derive real slippage
guards from them:

```ts
const pool = (await aqua.pools.forPair(XLM, AQUA)).find(p => p.type === "concentrated")!;

const est = await pool.estimatePositionDeposit({
  amounts: [[XLM, 100_000_000n], [AQUA, 1_000_000_000n]],
  priceRange: ["0.9", "1.1"],   // snaps to tick spacing; or tickRange: [lower, upper]
});
const opened = await est.execute({ slippage: 0.01 }); // min-liquidity guard from the estimate

await pool.positionRanges();                          // all of the signer's ranges
await pool.positionRangeStatus(est.tickLower, est.tickUpper); // in_range / below / above
await pool.positionValue(est.tickLower, est.tickUpper); // principal / fees / total, split
await pool.claimPositionFees(est.tickLower, est.tickUpper);
await pool.withdrawPosition({ tickLower: est.tickLower, tickUpper: est.tickUpper }); // full close
```

`tickFromPrice`, `priceAtTick`, and `snapTick` are exported for range math —
integer-exact and identical across both language packages.

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
    feeFraction: 30,   // 30 / feeDenominator=10000 -> 0.3% of the output
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
- **Fixed authorization** — every contract submission and unsigned transaction build carries client-defined authorization, checked by simulation in `enforce` mode. Simulation supplies resources, never additional permissions. Deposit transfers authorize the desired amounts, withdrawals authorize the share-token burn where applicable, and claims authorize their call tree. Exact-output swaps authorize the maximum input; the contract refunds the difference.
- **Typed errors** — `SlippageError` (with `requote()`), `PausedError` (kill switches — not your bug), `NoRouteError`, `UserRejectedError`, `TxTimeoutError`.

## Signers

Anything with `publicKey()` plus either `secret()` (a stellar-sdk `Keypair`) or `sign(xdr)` (wallet adapters). Reads — `quote()` — need no signer at all.

## Escape hatches

`quote.buildTransaction()` returns the simulated, unsigned envelope XDR with the same fixed authorization as `quote.execute()`, for external signing flows (multisig, custom pipelines). `client.api` is the typed REST client.

`client.contract.call(fn, ...scVals)` invokes the router with source-account authorization for that exact root call. Raw calls that need nested authorization must migrate to `client.contract.callWithAuth(fn, args, auth)`, supplying the complete `xdr.SorobanAuthorizationEntry[]`. The SDK exports `authorizedInvocation` and `sourceAccountEntry` to construct it:

```ts
import { authorizedInvocation, sourceAccountEntry } from "@aquariusdefi/sdk";

// fn, args and subInvocations describe the exact calls you intend to authorize.
const auth = [sourceAccountEntry(
  authorizedInvocation(aqua.network.router, fn, args, subInvocations),
)];
await aqua.contract.callWithAuth(fn, args, auth);
```

Pass `[]` explicitly for calls requiring no authorization; it stays empty through assembly. Missing or incomplete authorization fails during enforced simulation, with no fallback to recording auth. Existing signed address credentials, if supplied, must be valid for the call.

Read and estimate calls may still use recording simulation to obtain return values; their simulated authorization is never reused in submitted calls. Archived state can still trigger a separately signed restore transaction when a signer is available.

## Infrastructure

Defaults point at the protocol's own endpoints: the mainnet RPC is
`https://soroban-rpc.aqua.network` — the same node the Aquarius web app and
backend use. Running your own infrastructure? Every endpoint is overridable:

```ts
const aqua = new AquariusClient({
  network: "mainnet",
  rpcUrl: "https://your-rpc.example.com",
  horizonUrl: "https://your-horizon.example.com",
});
```

## Amounts

All amounts are `bigint` in token base units (stroops for classic assets: 1 token = 10^7).

Questions and integration help: [Discord](https://discord.gg/sgzFscHp4C).
