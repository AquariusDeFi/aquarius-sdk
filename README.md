# Aquarius SDK

Official SDKs for building on [Aquarius](https://aqua.network) — swaps, liquidity, and rewards on Stellar, in Python and TypeScript.

**Status: 0.5.x.** Swaps (quote → execute in both modes) and the liquidity lifecycle — pool discovery, deposit, withdraw, rewards, positions — are complete in both languages, each verified end to end with real testnet transactions. Concentrated liquidity position management (range deposits, withdrawals, fee claims, position reads) is available as a **beta** surface: the concentrated contracts are under an ongoing external audit, and router deposits into concentrated pools remain refused — ranges are managed through the pool contract directly. Provider-fee collectors — routing swaps through your own fee-taking contract, deploying one, and claiming what it accumulates — are fully supported.

Alpha `0.6.0a3` (Python) / `0.6.0-alpha.3` (npm) adds canonical limit-order registry reads, on-chain placement/cancellation, and unsigned fill preparation. Install an explicit alpha version; the stable registry release remains unchanged. See the language READMEs for trusted deployment configuration and the network-capped lifetime. This release has offline fixture coverage; it does not certify a production limit-order deployment.

## Layout

| Directory | Package | Registry name |
| --- | --- | --- |
| `python/` | `import aquarius` | [`aquarius-sdk`](https://pypi.org/project/aquarius-sdk/) on PyPI |
| `javascript/` | `@aquariusdefi/sdk` | [`@aquariusdefi/sdk`](https://www.npmjs.com/package/@aquariusdefi/sdk) on npm |
| `testdata/` | Golden fixtures shared by both test suites | — |

## Try it

```bash
cd python
pip install -e .
python examples/demo.py   # two real swaps on testnet with a throwaway account
```

```python
from stellar_sdk import Keypair
from aquarius import AquariusClient, Asset, XLM

AQUA = Asset.classic("AQUA", "GAHPYWLK...LAGER")

aqua = AquariusClient(network="testnet", signer=Keypair.random())
aqua.fund_with_friendbot()
aqua.ensure_trustline(AQUA)

quote = aqua.quote(XLM, AQUA, amount_in=10_0000000)   # amount_out= for exact output
receipt = quote.execute()
```

`fund_with_friendbot()` / `fundWithFriendbot()` waits up to 30 seconds after
funding for the account to appear on the configured Horizon and RPC servers.
Only account absence is retried; a readiness timeout does not mean funding failed.

`swap(..., retries=...)` re-quotes only after a diagnosed slippage error. An
on-chain failure without recognized diagnostics raises `AquariusError` with the
transaction hash; inspect that transaction before deciding whether to retry.

Soroban transactions declare the simulated resource fee plus a headroom —
`resource_fee_headroom` / `resourceFeeHeadroom`, default `0.5` (+50%), `0`
disables. The declared resource fee is a cap and the unused part is refunded,
so the headroom costs nothing unless state changes between simulation and
apply make the transaction need it. The source account must still hold the
full declared fee (inclusion + resource + headroom): it is debited before
execution and the unused part refunded after apply, so leave that margin when
spending the whole XLM balance. Re-preparing the XDR from
`build_transaction()` / `buildTransaction()` with stellar-sdk's own
`prepare_transaction` / `prepareTransaction` drops the headroom.

They also declare the simulated CPU instructions plus a headroom —
`instruction_headroom` / `instructionHeadroom`, default `0.25` (+25%), `0`
disables — capped at the network's per-transaction limit. The declared count is
a hard limit (a transaction that needs more fails on-chain with
`INVOKE_HOST_FUNCTION_RESOURCE_LIMIT_EXCEEDED`), and the resource fee is raised
by the non-refundable compute fee of the added instructions, which is charged
whether or not they are used (under 0.0001 XLM for a typical swap at current
mainnet rates).

`wait_for_next_ledger()` / `waitForNextLedger()` waits until the RPC's latest
ledger is past the one that applied the client's last on-chain transaction
(confirmed or failed), or past an explicit `ledger`; with neither, it waits for
the next ledger. Call it between dependent writes whose second simulation
depends on ledger-time state the first one changed. Simulation runs on the
latest ledger's state, but a transaction applies in a later one: after a
deposit into a pool with rewards, the rewards contract rewrites the user's
reward entry only when rewards accrued since the user's last checkpoint, so a
withdraw or claim simulated on the deposit's own ledger declares that entry
read-only and fails on-chain once time has advanced. The method polls the RPC's
`getHealth` about once a second, returns the latest ledger observed, and raises
`AquariusError` after a timeout (default 30 s). The SDK never waits on its own:
simulations, reads and writes do not poll.

## Design principles

1. **Two-phase everything.** `quote()` → `Quote.execute()`. UIs show before they commit; the quote object carries everything needed to execute, so what you quoted is what you execute.
2. **Reads never need a signer.** Writes take one injected signer abstraction — a `Keypair` or a wallet-adapter callback. The SDK never accepts a raw secret string where avoidable and never stores keys.
3. **Escape hatches at every layer.** `Quote.buildTransaction()` returns unsigned XDR; `client.contract.call()` invokes the router raw; `client.api` is the typed REST client. The SDK wraps, it never traps.
4. **Protocol details are the SDK's problem.** `swaps_chain` encoding, token-vector sorting, pool hashes, transaction meta v3/v4, u128 conversion — none of these exist in the public surface.
5. **Typed errors that encode what we know.** Guard failures raise `SlippageError` ("re-quote and retry"), kill switches raise `PausedError` ("not your bug"), missing routes raise `NoRouteError`.
6. **Language parity is a feature.** Same names, same semantics in both packages, enforced by shared golden fixtures in `testdata/`. Feature releases move in lockstep minor versions (`py-v0.4.x` and `js-v0.4.x` have the same surface).
7. **Authorization is fixed before submission.** Every contract write supplies client-built authorization and simulates in enforcement mode. Simulation supplies resources and fees, never the authorization to sign. Raw calls default to root-only source-account authorization; calls needing nested authorization must supply their complete tree (see the language READMEs). Read and quote simulations may still record authorization, which is never reused for submission.

## Scope of v1

Swaps (both modes), provider-fee collectors and separate output recipients, pool discovery, deposit/withdraw/claim, positions overview, trustline and friendbot helpers. Explicitly out: wallet and key management, price oracles, governance/ICE, SDEX rewards, historical data.

## Releases

Tags trigger publishing: `py-v*` → PyPI, `js-v*` → npm. Independent patches, lockstep minors.

## Development

- Python: `cd python && pip install -e .[dev] && pytest`
- TypeScript: `cd javascript && npm install && npm run typecheck`
- Fixtures in `testdata/` are recorded from the live testnet API; when the API contract changes, re-record them in the same PR that adapts the parsers — both languages, one PR.
