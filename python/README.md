# aquarius-sdk

Installation: `pip install aquarius-sdk==0.6.0`.

Public API HTTP failures raise `APIHTTPError`, a subclass of `AquariusError`,
with `status_code` and `retry_after` in seconds (`None` when unavailable).
Response bodies, including draft-error details, are omitted; callers control retries.

The Python SDK for [Aquarius](https://aqua.network) — swaps, liquidity, and rewards on Stellar.

**Status: 0.6.x — swaps and the liquidity lifecycle are complete and verified with real testnet transactions.** Concentrated liquidity position management is available as a beta surface (the contracts are under an ongoing external audit). The API may still change before 1.0.

## Swap through a specific pool

`client.quote()`/`swap()` route through the path-finding API. To pin a swap to
one pool you trust — your own routing, API independence — quote and swap on the
pool itself; the estimate comes from the router's on-chain `estimate_swap`:

```python
pool = next(p for p in client.pools_for_pair(XLM, AQUA) if p.fee_bps == 10)

quote = pool.quote(XLM, AQUA, amount_in=100_0000000)   # no signer needed
receipt = quote.execute()                              # swaps in this pool only
# or: pool.swap(XLM, AQUA, amount_in=100_0000000, retries=3)
```

Exact input only — the router has no single-pool strict-receive; for exact
output use `client.quote(..., amount_out=...)`.

## Concentrated liquidity positions (beta)

A position is the key `(owner, tick_lower, tick_upper)` on the pool contract — no
NFTs, merged on re-deposit, at most 20 ranges per account. Quotes come from the
contract's own estimators; `execute`/`withdraw_position` derive real slippage
guards from them:

```python
pool = next(p for p in aqua.pools_for_pair(XLM, AQUA) if p.type == "concentrated")

est = pool.estimate_position_deposit(
    {XLM: 10_0000000, AQUA: 100_0000000},
    price_range=("0.9", "1.1"),   # snaps to tick spacing; or tick_range=(lower, upper)
)
opened = est.execute(slippage=0.01)          # min-liquidity guard from the estimate

pool.position_ranges()                        # all of the signer's ranges
pool.position_range_status(est.tick_lower, est.tick_upper)  # in_range / below / above
pool.position_value(est.tick_lower, est.tick_upper)  # principal / fees / total, split
pool.claim_position_fees(est.tick_lower, est.tick_upper)
pool.withdraw_position(est.tick_lower, est.tick_upper)  # full close, auto-claims fees
```

`tick_from_price`, `price_at_tick`, and `snap_tick` are exported for range math —
integer-exact and identical across both language packages.

Requires `stellar-sdk>=17.0.0,<18` with Protocol 30 support.

```bash
pip install aquarius-sdk
```

```python
from stellar_sdk import Keypair
from aquarius import AquariusClient, Asset, XLM, SlippageError

AQUA = Asset.classic("AQUA", "GBNZ...AQUA")

aqua = AquariusClient(network="mainnet", signer=Keypair.from_secret(secret))

# exact input: quote, inspect, execute
quote = aqua.quote(XLM, AQUA, amount_in=100_0000000, slippage=0.01)
receipt = quote.execute()

# exact output: pass amount_out instead — strict-receive throughout
quote = aqua.quote(XLM, AQUA, amount_out=500_0000000)
```

## Provider fees

Pass the collector configuration with the quote. The SDK keeps the fee math exact, routes through the collector, and sends output to `recipient` without requiring that address to sign:

```python
from aquarius import ProviderFeeConfig

provider_fee = ProviderFeeConfig(
    contract_id="C...",
    fee_fraction=30,   # 30 / fee_denominator=10_000 -> 0.3% of the output
    fee_denominator=10_000,
    recipient="G...",
)

quote = aqua.quote(
    XLM,
    AQUA,
    amount_in=100_0000000,
    slippage=0.005,
    provider_fee=provider_fee,
)
receipt = quote.execute()
```

Omit `recipient` to send output back to the signer through the collector's legacy swap methods. Use `amount_out` instead of `amount_in` for an exact-output provider swap.

## Liquidity

```python
pools = aqua.pools_for_pair(XLM, AQUA)          # discovered on-chain, sorted by type and fee
pool = pools[0]                                  # Pool(type="volatile", fee_bps=10, ...)

result = pool.deposit({XLM: 50_0000000, AQUA: 2500_0000000}, slippage=0.01)
print(result.shares)                             # pool share tokens minted

pool.pending_rewards()                           # accrued AQUA, in stroops
pool.claim_rewards()
pool.withdraw(result.shares, slippage=0.01)

aqua.positions()                                 # every pool where the signer holds shares
```

Deposit and withdrawal guards come from a simulation of the exact call, reduced by `slippage` — quoted-versus-executed drift is bounded the same way as for swaps. Reads (`reserves()`, `pending_rewards()`, `pools_for_pair()`) need no signer.

A withdraw or claim right after a deposit into a pool with rewards should first
wait for the next ledger:

```python
result = pool.deposit({XLM: 50_0000000, AQUA: 2500_0000000})
aqua.wait_for_next_ledger()                      # past the ledger that applied the deposit
pool.withdraw(result.shares)
```

Simulation runs on the latest ledger's state, but a transaction applies in a
later one. The rewards contract rewrites the user's reward entry only when
rewards accrued since the user's last checkpoint, so a withdraw simulated on
the deposit's own ledger declares that entry read-only and fails on-chain once
time has advanced. `wait_for_next_ledger(ledger=None, timeout=30.0)` waits until
the RPC's latest ledger is past `ledger` — by default the ledger of the client's
last on-chain transaction (confirmed or failed), or, if there is none, the
current one — polling `getHealth` about once a second, and returns the latest
ledger observed; it raises `AquariusError` on timeout. The SDK never waits on
its own.

## Programmatic on-chain limit orders

**Security migration in 0.6.0:** `create_onchain_limit_order()` and
`validate_onchain_limit_order_draft()` now require `expected_executor_reward_xlm`.
Obtain it from `get_limit_order_executor_reward()` on the trusted settlement and
have the caller approve it before creating the order; never copy it from the
registry draft. The SDK compares the draft's canonical fee to that approved
value and reads the settlement fee again before building or placing.
If the fee changes or cannot be read, the operation stops before signing.

Each token's approval defaults to the amount this order needs (the XLM sale
amount plus the fee when selling XLM). To preserve a larger shared allowance,
pass an explicit `max_allowances={token_contract: approved_total}` ceiling.
The SDK rejects existing or required allowances above that ceiling, without
silently reducing or renewing them. Omitted token ceilings default to this
order's requirement. Set the allowance expiration explicitly as described below.

Receive-trustline support in Python `0.6.0a6`:
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

```python
import os

from aquarius import (
    AquariusClient,
    LimitOrderConfig,
    NoRouteError,
    XLM,
    parse_find_path_response,
)

aqua = AquariusClient(
    network="testnet",
    signer=signer,
    limit_orders=LimitOrderConfig(
        settlement=os.environ["AQUARIUS_LIMIT_ORDER_SETTLEMENT"],
        batcher=os.environ["AQUARIUS_BATCHER"],
    ),
)
current_ledger = aqua.latest_ledger()
expected_reward = aqua.get_limit_order_executor_reward()
# Present this fee and the allowance horizon for approval before proceeding.
order = aqua.create_onchain_limit_order(
    XLM,
    AQUA,
    sell_amount=100_0000000,
    min_buy_amount=500_0000000,
    valid_after_ledger=current_ledger,
    expires_at_ledger=current_ledger + 17_280,
    expected_executor_reward_xlm=expected_reward,
    allowance_expiration_ledger=current_ledger + 17_280,
)
receipt = order.place()
```

`allowance_expiration_ledger` is explicit because SEP-41 `allowance()` does not
return the existing expiration. Keep it at or beyond this order and every other
open order sharing the settlement allowance. It does not affect the order ID.
For custom C accounts, use `validate_onchain_limit_order_draft()` and
`build_onchain_placement_args()` with the account's own authorization policy.
These lower-level helpers do not query the network: supply an independently
approved fee and recheck the settlement before signing.
The existing contract is unchanged. A fee change after the transaction is signed
can still leave an unfillable order and its bounded allowance; the SDK never
silently increases the approved fee to compensate.

`batcher` is required only for `CONTRACT_ONCHAIN` placement. Registry reads,
cancellation, and filling need the trusted settlement address:

```python
aqua = AquariusClient(
    network="testnet",
    signer=signer,
    limit_orders=LimitOrderConfig(
        settlement=os.environ["AQUARIUS_LIMIT_ORDER_SETTLEMENT"],
    ),
)

orders = aqua.open_limit_orders(maker=signer.public_key)
order = aqua.get_limit_order(orders[0].order_id)
order.cancel()
```

An independent filler can request an exact-send route and prepare execution:

```python
response = aqua.api.find_path(
    {
        "token_in_address": order.order.sell_token,
        "token_out_address": order.order.buy_token,
        "amount": str(order.order.sell_amount),
    },
    exact_input=True,
)
route = parse_find_path_response(
    response,
    amount_in=order.order.sell_amount,
    slippage_bps=0,
    pair_label=f"{order.order.sell_token} -> {order.order.buy_token}",
)
xlm_token = XLM.contract_id(aqua.network.passphrase)
if route.amount_out < order.order.required_router_min(xlm_token):
    raise NoRouteError("Current route does not meet the order minimum")

prepared = order.prepare_fill(route.swap_chain_xdr)
result = prepared.execute()
```

The existing generic path lookup and parser are reused unchanged. Route lookup
and limit policy are separate primitives. Before returning `prepared`, the SDK
validates the registry record, detached
`ADDRESS_V2` invocation tree or confirmed on-chain placement, settlement
receipt, maker minimum, exact execution fee, and maximum transaction fee.

Preparation uses enforced authorization, preserves the maker's signed proof,
and applies the configured CPU and resource fee headroom before checking that
the maximum transaction fee is below the execution reward. A restore preamble
aborts fill preparation without signing or submitting. Unsigned placement and
cancellation builders also never sign or submit a restore transaction.

The prepared receipt is a simulation preview. Execution returns the validated
receipt from the confirmed transaction and fails if that receipt is absent or
violates the order's payout commitments.

Use the registry's current network and product lifetime limits. Expiration must
be at or below `current_ledger + max_entry_ttl - 1`, including for orders whose
valid-after ledger is in the future. The allowance horizon must satisfy the
network's current allowance limit and cover the order. Annual orders are not
supported by the agreed one-signature flow.

## What the SDK handles for you

- **Routing** — quotes come from the find-path API; the swap chain XDR is passed through untouched.
- **Transaction lifecycle** — simulation, assembly, submission with congestion retries (same-hash resubmission with backoff), and confirmation polling.
- **Fixed authorization** — every contract write and unsigned transaction uses client-built authorization trees. Preparation simulates in `enforce` mode, uses the response for resources, and preserves the exact operation and auth through restore and sequence retries. RPC-returned auth is never added, including when the supplied list is empty.
- **Archived state** — if simulation reports expired ledger entries, the SDK restores them (one extra signed transaction) and retries automatically.
- **Typed errors** — `SlippageError` (with `requote()`), `PausedError` (kill switches — not your bug), `NoRouteError`, `UserRejectedError`, `TxTimeoutError`.

## Signers

A stellar-sdk `Keypair` works as-is. Custom signers provide `public_key` plus `sign(tx_xdr) -> str` returning the signed envelope XDR. Reads — `quote()` — need no signer at all.

## Escape hatches

`quote.build_transaction()` returns the simulated, unsigned envelope XDR for external signing flows, with the same fixed authorization as `execute()`. `client.api` is the typed REST client.

`client.contract_call(fn, *scvals)` invokes the router raw and authorizes only
that exact root call with source-account credentials. Raw calls that previously
relied on simulation to discover nested permissions must now provide those
permissions explicitly with `auth=[...]`, or use the corresponding high-level
method such as `pool.deposit()`. An incomplete tree fails during enforced
simulation before the contract transaction is signed.

For example, an explicit raw reward claim mirrors the router and pool calls:

```python
from stellar_sdk import scval
from aquarius.authorization import authorized_invocation, source_account_entry

user = scval.to_address(public_key)  # the transaction source account
args = [
    user,
    scval.to_vec([scval.to_address(token) for token in pool.tokens]),
    scval.to_bytes(pool.pool_hash),
]
entry = source_account_entry(authorized_invocation(
    aqua.network.router, "claim", args,
    [authorized_invocation(pool.address, "claim", [user])],
))
aqua.contract_call("claim", *args, auth=[entry])
```

Pass `auth=[]` when the call requires no authorization; the empty list remains
empty after assembly. Reads and estimates can still use recording simulation,
but their recorded auth never enters a transaction for signing. Archived-state
restoration remains a separate footprint operation when a signer is available.

## Infrastructure

Defaults point at the protocol's own endpoints: the mainnet RPC is
`https://soroban-rpc.aqua.network` — the same node the Aquarius web app and
backend use. Running your own infrastructure? Every endpoint is overridable:

```python
aqua = AquariusClient(
    network="mainnet",
    rpc_url="https://your-rpc.example.com",
    horizon_url="https://your-horizon.example.com",
)
```

## Fees

`base_fee` (default `100_000` stroops) is the inclusion fee bid. On top of it,
every Soroban transaction declares a resource fee taken from simulation, raised
by `resource_fee_headroom` (default `0.5`, i.e. +50%; `0` disables):

```python
aqua = AquariusClient(network="mainnet", signer=signer, resource_fee_headroom=0.3)
```

The declared resource fee is a cap: the network charges the non-refundable part
plus the refundable part actually consumed (rent, events, return value) and
refunds the rest, so headroom costs nothing unless it is used. The refundable
part depends on ledger state at apply time, so the bare simulated fee can fall
short and fail the transaction on-chain with
`INVOKE_HOST_FUNCTION_INSUFFICIENT_REFUNDABLE_FEE`. The headroom is applied
before signing (also to automatic restore transactions and to
`quote.build_transaction()`), so wallets see and sign the final fee.

The source account must hold the full declared fee — inclusion fee plus
resource fee plus headroom: it is debited before execution, and the unused part
is refunded after apply. When spending the whole XLM balance, leave that margin.
Re-preparing the XDR from `quote.build_transaction()` with stellar-sdk's own
`prepare_transaction` re-simulates and replaces the resource fee, which drops the
headroom.

Declared CPU instructions are a hard limit too: a transaction that needs more
than it declares fails on-chain with
`INVOKE_HOST_FUNCTION_RESOURCE_LIMIT_EXCEEDED`, and actual usage can exceed the
simulated count by several percent. So the simulated instructions are raised by
`instruction_headroom` (default `0.25`, i.e. +25%; `0` disables), capped at the
network's per-transaction limit (read from the network config and cached), and
the resource fee by the compute fee of the added instructions — non-refundable,
under 0.0001 XLM for a typical swap at current mainnet rates — before the fee
headroom is applied on top. Restore transactions run no contract code and keep
the simulated instructions.

```python
aqua = AquariusClient(network="mainnet", signer=signer, instruction_headroom=0.4)
```

## Amounts

All amounts are integers in token base units (stroops for classic assets: 1 token = 10^7).

Questions and integration help: [Discord](https://discord.gg/sgzFscHp4C).

## Maintenance

[misty-forest](https://github.com/misty-forest) maintains the Aquarius SDK, including security review, vulnerability remediation, and ongoing development.

### Opt-in split primitives (next release)

`normalize_sell_swap_plans(response, token_in, token_out, amount_in)` validates
Sell-only backend split candidates while preserving the ordinary fallback.
`build_sell_swap_operation(source=..., token_in=..., token_out=..., router=...,
split_router=..., plan=..., minimum=...)` returns an unsigned operation with
fixed ordered input-transfer authorization and one aggregate output minimum.
`get_swap_minimum(output, "1")` accepts slippage as a percent string (1%), and
`get_sell_swap_result(retval, leg_count, with_trustline=False)` decodes outputs.
Amounts are canonical raw-unit strings. Optional `batch` plus
`trustline={"asset_code": ..., "issuer": ..., "network_passphrase": ...}` builds
atomic classic-output trust + swap and verifies the asset contract.

Both Python and JavaScript expose the same split capabilities. Python callbacks
are synchronous, following the existing Python SDK; JavaScript callbacks return
Promises. Existing `quote`/`swap` and provider-fee behavior stays ordinary.

```python
from aquarius import (
    normalize_sell_swap_plans, prepare_sell_swap_plans, build_sell_swap_operation,
    load_swap_resource_limits, assert_swap_resources, assert_swap_authorization,
    get_sell_swap_result,
)

plans = normalize_sell_swap_plans(response, token_in, token_out, amount_in)
limits = load_swap_resource_limits(server, network_passphrase)

def simulate(plan, minimum):
    operation = build_sell_swap_operation(
        source=source, token_in=token_in, token_out=token_out, router=router,
        split_router=split_router, plan=plan, minimum=minimum,
    )
    # Application helper: enforce fixed auth, reject errors/restores, assemble
    # the unsigned transaction and decode the diagnostic events and return XDR.
    tx, events, retval, ledger = simulate_and_assemble(operation)
    assert_swap_authorization(tx, source, operation.to_xdr_object().to_xdr())
    if len(plan.legs) > 1 and ledger < limits.latest_ledger:
        raise ValueError("Simulation predates network configuration")
    assert_swap_resources(tx, limits, {"events": events, "retval": retval}, len(plan.legs) > 1)
    return {"tx": tx, "outputs": get_sell_swap_result(retval, len(plan.legs))}

selected = prepare_sell_swap_plans(plans, "1", simulate)
# Display selected.plan, selected.minimum_output and the transaction fee.
```

`simulate_and_assemble` is application code, not an SDK method. It must reject
restore/error responses and re-check account, network and quote identity across
network calls. If network configuration cannot be loaded, retain only the
ordinary one-leg plan. The selector probes complete ordered execution and then
binds one aggregate minimum; it returns only a stable bounded simulation.
Selection maximizes simulated output, prefers fewer parts on ties and isolates
candidate failures so a failing split cannot remove a valid ordinary fallback.
No candidate object is mutated. Parts sharing pools must see preceding writes.

Resource checks cover the RPC's declarations, protocol-dependent disk reads,
footprint, worst-case signed envelope and successful contract/system events plus
the complete return value. Split gets 50% of current network caps; ordinary
routes get hard caps. RPC does not expose exact memory headroom, so full
simulation and runtime limits remain necessary. These helpers never trim
resources to fit, sign, submit or restore storage. Publication is a separate
release.

### Shared split API contract

| JavaScript | Python |
| --- | --- |
| `normalizeSellSwapPlans` | `normalize_sell_swap_plans` |
| `sellAmountToRaw` | `sell_amount_to_raw` |
| `getSwapMinimum` | `get_swap_minimum` |
| `prepareSellSwapPlans` | `prepare_sell_swap_plans` |
| `buildSellSwapOperation` | `build_sell_swap_operation` |
| `getSellSwapResult` | `get_sell_swap_result` |
| `getSwapResult` | `get_swap_result` |
| `loadSwapResourceLimits` | `load_swap_resource_limits` |
| `assertSwapResources` | `assert_swap_resources` |
| `assertSwapAuthorization` | `assert_swap_authorization` |

Both test suites consume `testdata/split-behavior.json` and
`testdata/split-resources.json`: exact amounts, malformed quotes, conservation,
minimum rounding, probe/bounded transitions, ranking/fallback, resource
boundaries, protocol configuration, event/return bytes, fixed authorization and
identical operation XDR. The shared capability list checks both public exports.
Changes to split behavior must update both implementations and shared cases in
the same PR.
