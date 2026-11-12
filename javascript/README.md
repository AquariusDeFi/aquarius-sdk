# @aquariusdefi/sdk

Installation: `npm install @aquariusdefi/sdk@0.7.0 @stellar/stellar-sdk@^17.4.0`.

The TypeScript SDK for [Aquarius](https://aqua.network) — swaps, limit orders, liquidity, and rewards on Stellar.

**Status: 0.7.0 — swaps and the liquidity lifecycle are complete and verified with real testnet transactions.** Concentrated liquidity position management is available as a beta surface (the contracts are under an ongoing external audit). Pool creation, gauge incentives, reward accounting and the batch-contract flows (0.6) mirror the Aquarius web app's transaction shapes and are covered by unit tests; run them against testnet before relying on them. The API may still change before 1.0.

Requires Node.js 22.12 or newer and `@stellar/stellar-sdk` 17.x (at least 17.4.0)
as a peer dependency. Browser bundlers resolve the SDK's explicit `buffer`
dependency; no global `Buffer` polyfill is required.

**New in 0.7.0:** prepare and place limit orders through the connected wallet,
read open orders and completion-sorted history, and cancel through the returned
order record. The SDK resolves signing capabilities, execution rewards, ledger
windows and receive trustlines. See [Limit orders](#limit-orders-javascript) for
the integration flow and the [changelog](CHANGELOG.md#070) for compatibility and
fixes. Version 0.7.0 also adds staged split swaps, provider split fees and native
receive trust, and fixes simulation error classification and automatic
restoration during limit-order fill preparation. The existing programmatic
APIs remain available.

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

Requires Node.js 22.12 or newer. Uses `@stellar/stellar-sdk` 17.4.0 for Protocol 30 XDR support.

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

// hold an address rather than a pair? resolve it directly
const byAddress = await aqua.pools.byAddress("CCSX...LWUVCRC");

const result = await pool.deposit({ amounts: [[XLM, 50_0000000n], [AQUA, 2500_0000000n]] });
console.log(result.shares);                           // pool share tokens minted

await pool.pendingRewards();                          // accrued AQUA, in stroops
await pool.claimRewards();
await pool.withdraw({ shares: result.shares });

await aqua.positions();                               // every pool where the signer holds shares
```

Deposit and withdrawal guards come from a simulation of the exact call, reduced by `slippage` — quoted-versus-executed drift is bounded the same way as for swaps. Reads need no signer.

A withdraw or claim right after a deposit into a pool with rewards should first
wait for the next ledger:

```ts
const result = await pool.deposit({ amounts: [[XLM, 50_0000000n], [AQUA, 2500_0000000n]] });
await aqua.waitForNextLedger();                       // past the ledger that applied the deposit
await pool.withdraw({ shares: result.shares });
```

Simulation runs on the latest ledger's state, but a transaction applies in a
later one. The rewards contract rewrites the user's reward entry only when
rewards accrued since the user's last checkpoint, so a withdraw simulated on
the deposit's own ledger declares that entry read-only and fails on-chain once
time has advanced. `waitForNextLedger({ ledger?, timeoutMs? })` waits until the
RPC's latest ledger is past `ledger` — by default the ledger of the client's
last on-chain transaction (confirmed or failed), or, if there is none, the
current one — polling `getHealth` about once a second, and resolves to the
latest ledger observed; it rejects with `AquariusError` after `timeoutMs`
(default 30 000). The SDK never waits on its own.

`pools.byAddress` reads the pool's tokens, hash, type and fee from the indexer
in one request. A pool the indexer has not picked up yet cannot be resolved
from an address alone — pass the pair and it is discovered on-chain instead:
`byAddress(address, { tokens: [XLM, AQUA] })`.

### Withdrawing through the pool, with claims

The router's `withdraw` is the plain path. `withdrawAndClaim` adds the pool's
claims in the same transaction — one signature via the batch contract.
Stable pools also support single-token and imbalanced withdrawals:

```ts
await pool.withdrawAndClaim({ shares, claimRewards: true, claimIncentives: true });
await stablePool.withdrawOneCoin({ shares, token: AQUA });   // everything in one token
await stablePool.withdrawImbalanced({ amounts: [[XLM, 10_0000000n], [AQUA, 0n]] }); // exact amounts out

await pool.estimateWithdraw(shares);            // per token
await stablePool.estimateWithdrawOneCoin(shares);     // per token, if taken alone
await stablePool.estimateWithdrawImbalanced(amounts); // shares it would burn
```

Minimums (or the share cap, for imbalanced) come from the contract's own
estimators reduced (or raised) by `slippage`; the share burn the wallet
sees is bounded to exactly what the call may consume.

### Rewards, boost and incentives

```ts
await pool.rewardsInfo();                // to_claim, tps, expiry, working balance/supply, ...
await pool.rewardsEnabled();             // AQUA rewards opt-in state
await pool.setRewardsEnabled(false);
await pool.estimateWorkingBalance(shares);              // boost inputs for a share amount
await pool.estimatePositionWorkingBalance(lo, hi, liq); // ...or a concentrated position

await pool.incentives();                 // gauge incentives, with the signer's accrual
await pool.claimIncentives();
await pool.gauges();                     // reward token -> gauge contract
await pool.gaugeFor(token);              // ...or where the router will deploy one for a new token
await aqua.incentives.config();          // min duration / min daily amount for scheduling
await pool.scheduleIncentive({ token: AQUA, tps, startAt, durationSeconds });
```

Scheduling funds `tps * duration` of the token upfront. Its authorization is
built client-side down to that transfer — into the token's gauge on volatile
and stable pools (derived the way the router deploys it when the token is
new), into the incentives vault on concentrated pools — so the wallet shows
exactly what is spent. The tree carries the pool's current working supply;
a deposit landing between build and submit invalidates it, the call fails
without spending, and can simply be rebuilt.

Claims across pools go under one signature too, in any mix of kinds:

```ts
await aqua.claim([
  { pool: a, kind: "rewards" },
  { pool: b, kind: "incentives" },
  { pool: c, kind: "positionFees" },
]);
```

### Creating a pool

A pool is created together with its first deposit — there is no way to
create an empty one. The creation fee (`aqua.poolCreationFee()`), the
pool init and the deposit are one atomic batch:

```ts
const { pool, txHash } = await aqua.pools.create({
  type: "volatile",               // or "stable" (2+ tokens), or "concentrated"
  tokens: [XLM, AQUA],
  feeBps: 30,
  amounts: [[XLM, 50_0000000n], [AQUA, 2500_0000000n]],
  slippage: 0.01,                 // default: tolerate 1% fewer shares/liquidity
  // concentrated only — the range, snapped to the fee tier's tick spacing:
  // priceRange: ["0.9", "1.1"]  or  tickRange: [lower, upper]
});
```

The pool's address is known before the transaction is signed (from a
simulation of the init), so `buildCreate` returns both the envelope XDR
and the `Pool` it will create. The SDK then simulates the entire `init +
deposit` batch and derives a minimum share/liquidity amount from that result.
The final invocation and its authorization both carry this guard. If init
resolves an existing pool, the same guard applies to the deposit into it.
`slippage` must be a finite fraction in `[0, 1)`; a positive estimate always
keeps a minimum of at least one base unit.

### Swapping into an asset you don't hold yet

```ts
await quote.execute({ addTrustline: true });          // trustline + swap, one signature
await quote.buildTransaction({ addTrustline: true });
```

Classic assets only, and only when the issuer does not require
authorization — the trustline is created by the asset contract's `trust`
in the same batch as the swap.

### Batch reads

`aqua.batch.read(calls)` simulates many contract reads in one RPC
round-trip, returning one value per call in order; a batch that overflows
the simulation budget is split automatically.

### Signing elsewhere

Liquidity writes and routed quotes have a `build*` twin that returns the
simulated, unsigned envelope XDR with its guards and auth tree. Builds and
their preliminary reads never sign or submit transactions. This is the path
for wallet adapters, hardware wallets and multisig,
where the transaction has to be inspected — or fee-quoted — before a
signature exists:

```ts
const xdr = await pool.buildDeposit({ amounts: [[XLM, 50_0000000n], [AQUA, 2500_0000000n]] });
// ...show the fee, check balances, hand it to a wallet, submit it yourself

await pool.buildWithdraw({ shares });
await pool.buildClaimRewards();
await pool.buildWithdrawPosition({ tickLower, tickUpper });
await pool.buildClaimPositionFees(tickLower, tickUpper);
await pool.buildClaimAllPositionFees();
await (await pool.estimatePositionDeposit({ amounts, priceRange })).buildTransaction();

await pool.buildWithdrawAndClaim({ shares, claimRewards: true });
await pool.buildWithdrawOneCoin({ shares, token });
await pool.buildWithdrawImbalanced({ amounts });
await pool.buildSetRewardsEnabled(true);
await pool.buildClaimIncentives();
await pool.buildScheduleIncentive({ token, tps, startAt, durationSeconds });
await aqua.buildClaim(items);
await aqua.pools.buildCreate(params);          // -> { xdr, pool }
await quote.buildTransaction({ addTrustline: true });
```

When a separate restore is required, a build throws `RestoreRequiredError`
with an unsigned `restoreTransactionXdr`. Have the user review/sign it,
submit it, wait for confirmation, and call the original `build*` again to
get fresh sequence numbers and simulation data. Reads still return their
simulated values when entries are archived; they do not restore anything.

```ts
import { RestoreRequiredError } from "@aquariusdefi/sdk";

try {
  const xdr = await pool.buildClaimRewards();
  // ...review, sign and submit xdr through your wallet flow
} catch (error) {
  if (error instanceof RestoreRequiredError) {
    const restoreXdr = error.restoreTransactionXdr;
    // ...review, sign and submit restoreXdr; after confirmation, rebuild the claim
  } else {
    throw error;
  }
}
```

The client does not see transactions you submit yourself, so
`waitForNextLedger()` does not default to their ledger. Before a dependent
build (e.g. a withdraw after a deposit into a pool with rewards), pass the
ledger the previous transaction applied in: `waitForNextLedger({ ledger })`.

## Limit orders (JavaScript)

The wallet-facing manager below is available from `0.7.0`. Limit-order registry
and on-chain primitives were already available in `0.6.0`.

Use the same prepare/review/execute pattern as quotes. Configure the deployment
once; a connected signer supplies the account. A keypair supports detached
authorization automatically. A wallet adapter can expose `signAuthEntry(xdr)` in
addition to its usual `sign(transactionXdr)` method. Omit that capability when
unsupported; the SDK selects transaction placement. Multisig accounts use
transaction placement even when their wallet supports detached signing.

```ts
import { AquariusClient, Asset, XLM } from "@aquariusdefi/sdk";

const AQUA = Asset.classic("AQUA", aquaIssuer);
const aqua = new AquariusClient({
  network: "testnet",
  signer,
  limitOrders: {
    settlement: settlementAddress,
    batcher: batcherAddress,
    guard: guardAddress,
    apiUrl: registryUrl,
  },
});

const prepared = await aqua.limitOrders.prepare({
  from: XLM,
  to: AQUA, // Asset.classic(code, issuer) for a classic receive asset
  sellAmount: 10_0000000n,
  minBuyAmount: 100_0000000n,
  expiresIn: 24 * 60 * 60, // approximate duration, seconds
});

// Show prepared.summary to the user before placing.
// Includes the exact reward, expiration, signing path and trustline timing.
const order = await prepared.place();
console.log(order.orderId, order.order.sellAmount);

// These are independent actions for the application's order list and cancel UI.
const open = await aqua.limitOrders.open(); // connected maker by default
const history = await aqua.limitOrders.history();
const next = history.nextCursor
  ? await aqua.limitOrders.history(undefined, history.nextCursor)
  : null;
const sameOrder = await aqua.limitOrders.get(order.orderId);
// After the user confirms cancellation:
// await sameOrder.cancel();
```

`signer`, `aquaIssuer` and the deployment addresses above come from the
application's connected wallet and trusted network configuration.

### Wallet adapter and confirmation UI

Reuse the signer passed to `AquariusClient`. Application callbacks should return
the signed transaction XDR, or a base64 authorization signature / signed
authorization-entry XDR, respectively. Unwrap wallet-specific response objects
inside the adapter and pass the intended account and network to the wallet.

```ts
import type { Signer } from "@aquariusdefi/sdk";

// Application-provided address and wallet callbacks.
const signer: Signer = {
  publicKey: () => connectedAddress,
  sign: signTransactionWithWallet,
  ...(signAuthEntryWithWallet
    ? { signAuthEntry: signAuthEntryWithWallet }
    : {}),
};
```

Set `signAuthEntryWithWallet` to `undefined` when the connected wallet cannot sign
authorization entries; do not provide a stub that throws. The SDK also checks the
account's signer weights and thresholds before selecting detached signing. A
keypair provides detached signing automatically; multisig accounts use
transaction placement. Propagate wallet rejection so it stops the operation.

Build the confirmation UI from `prepared.summary`, rather than independently
fetching values that may differ from the reviewed draft:

| Field | Meaning |
| --- | --- |
| `sellAmount`, `minBuyAmount` | Reviewed base-unit amounts as `bigint`. |
| `executorRewardXlm` | Execution reward in stroops, paid when the order fills. |
| `expiresAtLedger`, `expiresIn` | Exact expiration ledger and approximate duration in seconds. |
| `signing` | `authorization` or `transaction`, selected before review. |
| `trustline.required`, `trustline.creation` | Whether a line is missing and whether it is added at `execution` or `placement`; otherwise `null`. |

Transaction placement pays a network fee when submitted, independently of
whether the order later fills. Detached placement signs an authorization and
publishes it to the registry without submitting a placement transaction.

### Preparation, placement and retries

`prepare()` fetches the current ledger, settlement reward and account state,
detects a missing receive trustline and pins the signing path before creating a
validated draft. It neither signs nor submits. `place()` rechecks the reviewed
conditions, signs and publishes/places that exact order. A change requiring new
consent stops the operation. Wallet rejection never falls back to a paid path.

A missing classic receive trustline is authorized for execution with detached
signing, or added at placement with transaction signing. Existing trustlines,
native assets, issuer-owned assets and contract-only Soroban assets do not add a
line. Assets needing issuer authorization are rejected before signing. Pass
classic assets as code/issuer so the SDK can derive their network-specific SAC.

Amounts are `bigint` in base units. `expiresIn` is an approximate duration in
seconds (5 seconds per ledger), bounded by the settlement and the 3,110,399-ledger
allowance cap. A request for 180 days uses that cap. No caller-supplied ledger,
trustline flag, placement mode or independently fetched reward is required.
Durations above `LIMIT_ORDER_MAX_DURATION_SECONDS` (180 days) throw an
`AquariusError` before any network request or wallet interaction. Legacy and
imported orders also reject ledger windows exceeding 3,110,399 ledgers; a lower
settlement limit still applies.

Wallet placement adds the new budget to verified remaining allowances, preserves
the longer logical expiry, and atomically guards the fee, unused order ID and
current allowances. Canonical XDR, approved amounts, network, settlement and the
exact authorization tree are verified before wallet interaction.

Reuse the same prepared object on retry: it retains the signed authorization or
transaction, coalesces concurrent placement calls and checks transaction
confirmation before resubmitting. A new `prepare()` is a new order.

For applications with an existing Vault or external-signature flow,
`prepared.place({ submitTransaction, prepareTransaction? })` accepts transport
adapters. The submit callback returns either `{ status: "confirmed",
transactionHash, ledger, createdAt }`, `{ status: "pending", transactionHash }`,
or `{ status: "failed" }`. A pending result remains `PENDING_SIGNATURES` and is
never reported as an open order. The receipt must refer to the exact built
transaction. `prepareTransaction` can handle the application's restoration UI.
`createdAt` is Unix time in seconds, accepted as either a number or a decimal
string, matching RPC responses. The application must wait for network
confirmation before returning `status: "confirmed"`.

Handle external-signature results explicitly:

```ts
const result = await prepared.place({ submitTransaction });
if (result.status === "PENDING_SIGNATURES") {
  // Show the application's existing pending-signatures UI.
  // Keep this prepared object and retry placement after signatures are collected.
} else {
  // result is the placed LimitOrderRecord; refresh the application's order list.
  console.log(result.orderId);
}
```

The escape hatches `prepared.buildTransaction()`,
`prepared.authorizationEntryXdr`, `prepared.authorize(signature)` and
`order.buildCancelTransaction()` remain available. Normal callers use
`prepare()` / `place()` and the returned order object's methods. Read-only clients
can pass an explicit maker to `open(maker)` / `history(maker)` without a signer.
All registry methods return the same bound `LimitOrderRecord` model; `.raw`
exposes its registry projection when needed by an existing application.

`open()` follows pagination and returns all open orders. For a bounded page, use
`list({ maker, status: "OPEN", limit, cursor })`. `history(maker, cursor, limit)`
defaults to 20 records, ordered by completion date; use the returned `nextCursor`
for subsequent pages. The SDK does not poll these lists. The application owns
refresh timing, wallet connection, confirmation dialogs and notifications.

For execution notifications, `getLimitOrderFillOperation(operation, settlement,
maker)` identifies a matching Horizon fill operation. Pass the corresponding
successful RPC transaction to `getLimitOrderFillAmounts(transaction, fill)` to
read actual amounts from settlement events, including contract-only Soroban
tokens. These helpers return `null` for unrelated records and do not start an
event stream themselves.

### Upgrading from 0.6.0 or a Git dependency

Existing programmatic methods remain available. Wallet applications can replace
manual ledger, trustline and signing-mode resolution with `prepare()` and review
its summary before calling `place()`. The 180-day / 3,110,399-ledger maximum also
applies to legacy and imported orders; the settlement can enforce a lower limit.

After `0.7.0` is published, replace the temporary Git URL or local tarball with
the npm version and commit the regenerated application lockfile:

```sh
yarn add @aquariusdefi/sdk@0.7.0 --exact
# Or, for npm consumers:
npm install @aquariusdefi/sdk@0.7.0 --save-exact
```

The required Node.js version and Stellar SDK peer dependency are unchanged from
`0.6.0`. Staged split swaps are explicit helpers and require compatible router
and collector contracts; ordinary `quote()` / `swap()` behavior is unchanged.
The ICE Locker/delegation builders, typed settlement routes and adaptive
resource retry helpers from `0.7.0-testnet.*` are not included. Keep the exact
prerelease pin if your application uses those APIs. Stable limit-order fills
retain legacy route encoding.

### Testing from GitHub before a release

The repository root provides a private Git-install manifest for this JavaScript
package. Its `prepare` script builds the same sources and TypeScript declarations;
normal npm releases continue to be published from `javascript/`.
Keep the root manifest's version and dependency ranges in sync with
`javascript/package.json`; the package consistency test checks this.

```sh
yarn add '@aquariusdefi/sdk@git+https://github.com/AquariusDeFi/aquarius-sdk.git#<full-commit-sha>'
```

Use a full commit SHA from the reviewed PR so installations are reproducible.
Git preparation needs development dependencies and lifecycle scripts enabled.
Before the consuming application's production release, replace the Git URL with
the published `@aquariusdefi/sdk` version and regenerate its lockfile.

### Local frontend integration

Run `npm install`, then `npm run pack:local` inside `javascript/`. The command
prints a tarball filename containing its content hash. It has the same files as
an npm release, without development dependencies. Install that file from a sibling
frontend with `yarn add @aquariusdefi/sdk@file:../aquarius-sdk/javascript/<filename>`.
Repack and install the newly printed filename after SDK changes; unique filenames
avoid Yarn Classic's stale local-tarball cache. Replace this local dependency with
the published SDK version before deploying the frontend independently.

## Legacy programmatic on-chain limit orders

The published explicit-ceiling API below is retained for compatibility. New
wallet integrations should use `limitOrders.prepare()` above. The legacy read
methods delegate to the same manager and return the same order model.

**Security migration in 0.6.0:** `createOnchainLimitOrder()` and
`validateOnchainLimitOrderDraft()` now require `expectedExecutorRewardXlm`.
Obtain it from `getLimitOrderExecutorReward()` on the trusted settlement and
have the caller approve it before creating the order; never copy it from the
registry draft. The SDK compares the draft's canonical fee to that approved
value and reads the settlement fee again before building or placing.
If the fee changes or cannot be read, the operation stops before signing.

Each token's approval defaults to the amount this order needs (the XLM sale
amount plus the fee when selling XLM). To preserve a larger shared allowance,
pass an explicit `maxAllowances: new Map([[tokenContract, approvedTotal]])` ceiling.
The SDK rejects existing or required allowances above that ceiling, without
silently reducing or renewing them. Omitted token ceilings default to this
order's requirement. Set the allowance expiration explicitly as described below.

Receive-trustline support in JavaScript `0.6.0-alpha.5`:
registry validation accepts both the legacy proof and the exact
`trust(maker)` + input/reward transfer proof. The latter needs the upgraded
settlement for missing classic trustlines; it retains the same order body and ID.
An old proof cannot gain trustline permission after signing.

For programmatic placement from a G account, passing a classic receive asset
(code and issuer) automatically prepends `trust` to the same approvals/placement
batch, covered by one transaction signature. Native assets and assets known only by contract ID do not add `trust`.
Lower-level draft builders automatically add the call when `buy_asset=Asset.classic(code, issuer)`
is passed to `validate_onchain_limit_order_draft` (JavaScript: `buyAsset` in the
validation context). There is no auto-trust opt-in or opt-out flag. The builder
derives the SAC address from code/issuer and the validated network passphrase,
and rejects mismatched metadata. Direct `OnchainLimitOrder` construction also
requires `network_passphrase` (JavaScript: `networkPassphrase`) for a classic
receive asset. SAC itself handles an existing line or contract maker as a no-op
and rejects unsupported issuer receivers.
Creation still requires account reserve and issuer approval where applicable.

When migrating from earlier alphas, remove `auto_trust` / `autoTrust`
arguments. Direct JavaScript `OnchainLimitOrder` construction no longer has the
boolean parameter before `buyAsset`; prefer the validated draft/client methods.


The examples below target `0.6.0`. Configure trusted
settlement and batcher addresses for `CONTRACT_ONCHAIN` placement:

```ts
const aqua = new AquariusClient({
  network: "testnet",
  signer,
  limitOrders: {
    settlement: process.env.AQUARIUS_LIMIT_ORDER_SETTLEMENT!,
    batcher: process.env.AQUARIUS_BATCHER!,
  },
});

const currentLedger = await aqua.latestLedger();
const expectedReward = await aqua.getLimitOrderExecutorReward();
// Present this fee and the allowance horizon for approval before proceeding.
const order = await aqua.createOnchainLimitOrder({
  from: XLM,
  to: AQUA,
  sellAmount: 100_0000000n,
  minBuyAmount: 500_0000000n,
  validAfterLedger: currentLedger,
  expiresAtLedger: currentLedger + 17_280,
  expectedExecutorRewardXlm: expectedReward,
  allowanceExpirationLedger: currentLedger + 17_280,
});
const receipt = await order.place();
```

`allowanceExpirationLedger` is explicit because SEP-41 `allowance()` does not
return the existing expiration. Keep it at or beyond this order and every other
open order sharing the settlement allowance. It does not affect the order ID.
For custom C accounts, use `validateOnchainLimitOrderDraft()` and
`buildOnchainPlacementArgs()` with the account's own authorization policy.
These lower-level helpers do not query the network: supply an independently
approved fee and recheck the settlement before signing.
The existing contract is unchanged. A fee change after the transaction is signed
can still leave an unfillable order and its bounded allowance; the SDK never
silently increases the approved fee to compensate.

`batcher` is required only for `CONTRACT_ONCHAIN` placement. Registry reads,
cancellation, and filling need the trusted settlement address:

```ts
const aqua = new AquariusClient({
  network: "testnet",
  signer,
  limitOrders: {
    settlement: process.env.AQUARIUS_LIMIT_ORDER_SETTLEMENT!,
  },
});

const orders = await aqua.openLimitOrders(signer.publicKey());
const order = await aqua.getLimitOrder(orders[0].orderId);
await order.cancel();
```

An independent filler can request an exact-send route and prepare execution:

```ts
const response = await aqua.api.findPath({
  token_in_address: order.order.sellToken,
  token_out_address: order.order.buyToken,
  amount: order.order.sellAmount.toString(),
}, true);
const route = parseFindPathResponse(response, {
  amountIn: order.order.sellAmount,
  slippageBps: 0,
  pairLabel: `${order.order.sellToken} -> ${order.order.buyToken}`,
});
const xlmToken = XLM.contractId(aqua.network.passphrase);
if (route.amountOut < order.order.requiredRouterMin(xlmToken)) {
  throw new NoRouteError("Current route does not meet the order minimum");
}

const prepared = await order.prepareFill(route.swapChainXdr);
const result = await prepared.execute();
```

The existing generic path lookup and parser are reused unchanged. Route lookup
and limit policy are separate primitives. Before returning `prepared`, the SDK
validates the registry record, detached
`ADDRESS_V2` invocation tree or confirmed on-chain placement, settlement
receipt, maker minimum, exact execution fee, and maximum transaction fee.

Preparation uses enforced authorization, preserves the maker's signed proof,
and applies the configured CPU and resource fee headroom before checking that
the maximum transaction fee is below the execution reward. Successful simulation
data may include automatic restoration entries and a restore preamble; fill
preparation retains those entries in the invocation's transaction data without
building or submitting a separate restore. Unsigned placement and cancellation
builders also never sign or submit a restore transaction.

The prepared receipt is a simulation preview. Execution returns the validated
receipt from the confirmed transaction and fails if that receipt is absent or
violates the order's payout commitments.

Use the registry's current network and product lifetime limits. Expiration must
be at or below `current_ledger + max_entry_ttl - 1`, including for orders whose
valid-after ledger is in the future. The allowance horizon must satisfy the
network's current allowance limit and cover the order. Annual orders are not
supported by the agreed one-signature flow.

## Split swaps

An exact-input swap that the backend splits across routes runs as one call to
the router's `swap_split`. `findPathSplit` returns one plan, split or not. The
SDK checks it, then builds the call with the user's whole authorization:
`swap_split` with all its arguments and the one input transfer.

```ts
import {
  normalizeSwapSplitPlan, getSwapMinimum, buildSwapSplitOperation,
  loadSwapResourceLimits, assertSwapAuthorization, assertSwapResources,
  getSwapSplitResult,
} from "@aquariusdefi/sdk";

const response = await aqua.api.findPathSplit({
  token_in_address: tokenIn, token_out_address: tokenOut, amount: amountIn,
});
const plan = normalizeSwapSplitPlan(response, tokenIn, tokenOut, amountIn);
const minimum = getSwapMinimum(plan.amountOut, "1"); // percent: "1" = 1%
const operation = buildSwapSplitOperation({
  source, router: aqua.network.router, tokenIn, tokenOut, plan, minimum,
});
const limits = await loadSwapResourceLimits(server, networkPassphrase);
// Your code: simulate once with this fixed authorization, reject restore or
// error results, then assemble with SDK CPU and resource-fee headroom.
const { transaction, simulation } = await simulate(operation);
const tx = await aqua.assembleTransaction(transaction, operation, simulation);
assertSwapAuthorization(tx, source, operation.toXdr("base64"));
if (simulation.latestLedger < limits.latestLedger) throw new Error("Stale simulation");
assertSwapResources(tx, limits, {
  events: simulation.events, retval: simulation.result.retval,
});
const output = getSwapSplitResult(simulation.result.retval, false);
// Show the plan, minimum, output and fee before signing.
```

`normalizeSwapSplitPlan` throws `NoRouteError` without a route, and an
"Invalid swap quote" error naming the failed check for a plan that does not
match the request or the router's execution of it: ask for a new quote, there
is no fallback. It checks the requested input, stage shares (integers summing
to 10000), every chain token by token from `tokenIn` through each stage to
`tokenOut`, each part's input against the router's allocation of its stage
input, outputs that add up to the next stage's input (within u128) and to
`amount_out`, and that `stages_xdr` is the encoding of the readable stages the
builder encodes. A plan has at most 4 stages, 4 parts per stage and 4 hops per
chain. `pools` and `tokens` are display data from the API: the signed call is
built only from the validated token addresses, pool indexes, shares and
amounts.

The minimum comes from your slippage on the quoted `amountOut`, never from the
API's `amount_out_min`. To authorize the output trustline inside the swap, pass
`trustline: {assetCode, issuer, networkPassphrase}` and omit `batch`. The builder
verifies the classic asset is `tokenOut` and puts `trust(source)` under the swap's
authorization. The updated contract opens a missing line atomically; XLM, WASM
tokens, issuers, contract recipients and existing lines need no new line.
A missing line needs the recipient's authorization and available XLM reserve;
issuer authorization restrictions still apply. Read the scalar result with
`getSwapSplitResult(retval)` even when a line was created.

For provider fees, pass the same `providerFee: {contractId, feeFraction,
feeDenominator, recipient?}` to `getSwapMinimum(plan.amountOut, slippage,
providerFee)` and `buildSwapSplitOperation`. The quoted amount is gross; the
minimum and returned amount are net. The collector rounds its fee up once on
the total output. An explicit recipient selects `swap_split_to`. The builder
can authorize a missing line only when the recipient is `source`; another
recipient must already have a line or supply its own authorization separately.
Use the configured collector's actual denominator and fee cap.

This requires the updated router and provider collector implementation. Existing
collectors are not upgradeable and must be replaced to support split swaps.
Explicit `batch` remains supported for legacy external `[trust, swap_split]`
calls; only that mode uses `getSwapSplitResult(retval, true)`.
The helpers never sign, submit or restore storage. Python has the same helpers
in snake_case, with shared fixtures in `testdata/split-*.json`.
Install with `npm install @aquariusdefi/sdk@0.7.0`.

## What the SDK handles for you

- **Routing** — quotes come from the find-path API; the swap chain XDR is passed through untouched.
- **Transaction lifecycle** — simulation, assembly, submission with congestion retries (same-hash resubmission with backoff), and confirmation polling. Results come from the RPC return value; no transaction-meta parsing anywhere.
- **Archived state** — executing writes restore entries and retry when a separate restore is required. Builds return unsigned restore XDR in `RestoreRequiredError`; reads never sign or submit.
- **Fixed authorization** — every contract submission and unsigned transaction build carries client-defined authorization, checked by simulation in `enforce` mode. Simulation supplies resources, never additional permissions. Deposit transfers authorize the desired amounts, withdrawals authorize the share-token burn where applicable, and claims authorize their call tree. Exact-output swaps authorize the maximum input; the contract refunds the difference.
- **Typed errors** — `SlippageError` (with `requote()`), `PausedError` (kill switches — not your bug), `NoRouteError`, `UserRejectedError`, `TxTimeoutError`.

## Signers

Anything with `publicKey()` plus either `secret()` (a stellar-sdk `Keypair`) or `sign(xdr)` (wallet adapters). Reads — `quote()` — need no signer at all.

## Escape hatches

`quote.buildTransaction()` returns the simulated, unsigned envelope XDR with the same fixed authorization as `quote.execute()`, for external signing flows (multisig, custom pipelines); every liquidity write has the same hatch under a `build*` name — see [Signing elsewhere](#signing-elsewhere). `client.api` is the typed REST client.

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

Read and estimate calls may still use recording simulation to obtain return values; their simulated authorization is never reused in submitted calls.

## Infrastructure

Defaults point at the protocol's own endpoints: the mainnet RPC is
`https://soroban-rpc.aqua.network` — the same node the Aquarius web app and
backend use. To use your own RPC or Horizon endpoint:

```ts
const aqua = new AquariusClient({
  network: "mainnet",
  rpcUrl: "https://your-rpc.example.com",
  horizonUrl: "https://your-horizon.example.com",
});
```

## Fees

`baseFee` (default `"100000"` stroops) is the inclusion fee bid. On top of it,
every Soroban transaction declares a resource fee taken from simulation, raised
by `resourceFeeHeadroom` (default `0.5`, i.e. +50%; `0` disables):

```ts
const aqua = new AquariusClient({ network: "mainnet", signer, resourceFeeHeadroom: 0.3 });
```

The declared resource fee is a cap: the network charges the non-refundable part
plus the refundable part actually consumed (rent, events, return value) and
refunds the rest, so headroom costs nothing unless it is used. The refundable
part depends on ledger state at apply time, so the bare simulated fee can fall
short and fail the transaction on-chain with
`INVOKE_HOST_FUNCTION_INSUFFICIENT_REFUNDABLE_FEE`. The headroom is applied
before signing (also to automatic restore transactions, to the unsigned
`restoreTransactionXdr` of `RestoreRequiredError`, and to
`quote.buildTransaction()` and every `build*` method), so wallets see and sign
the final fee.

The source account must hold the full declared fee — inclusion fee plus
resource fee plus headroom: it is debited before execution, and the unused part
is refunded after apply. When spending the whole XLM balance, leave that margin.
Re-preparing the XDR from `quote.buildTransaction()` or a `build*` method with
stellar-sdk's own `prepareTransaction` re-simulates and replaces the resource
fee, which drops the headroom.

Declared CPU instructions are a hard limit too: a transaction that needs more
than it declares fails on-chain with
`INVOKE_HOST_FUNCTION_RESOURCE_LIMIT_EXCEEDED`, and actual usage can exceed the
simulated count by several percent. So the simulated instructions are raised by
`instructionHeadroom` (default `0.25`, i.e. +25%; `0` disables), capped at the
network's per-transaction limit (read from the network config and cached), and
the resource fee by the compute fee of the added instructions — non-refundable,
under 0.0001 XLM for a typical swap at current mainnet rates — before the fee
headroom is applied on top. Restore transactions run no contract code and keep
the simulated instructions.

```ts
const aqua = new AquariusClient({ network: "mainnet", signer, instructionHeadroom: 0.4 });
```

## Amounts

All amounts are `bigint` in token base units (stroops for classic assets: 1 token = 10^7).

Questions and integration help: [Discord](https://discord.gg/sgzFscHp4C).

## Maintenance

[misty-forest](https://github.com/misty-forest) maintains the Aquarius SDK, including security review, vulnerability remediation, and ongoing development.
