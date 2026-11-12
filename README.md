# Aquarius SDK

Official SDKs for building on [Aquarius](https://aqua.network) — swaps, limit orders, liquidity, and rewards on Stellar, in Python and TypeScript.

**Status: 0.7.0.** Swaps (quote → execute in both modes) and the liquidity lifecycle — pool discovery, deposit, withdraw, rewards, positions — are complete in both languages, each verified end to end with real testnet transactions. Concentrated liquidity position management (range deposits, withdrawals, fee claims, position reads) is available as a **beta** surface: the concentrated contracts are under an ongoing external audit, and router deposits into concentrated pools remain refused — ranges are managed through the pool contract directly. Provider-fee collectors — routing swaps through your own fee-taking contract, deploying one, and claiming what it accumulates — are fully supported.

Version `0.7.0` adds validated staged split swaps, provider-fee split calls, contract-native receive trustline authorization, and fixed-operation assembly with SDK resource headroom in both languages. Split swaps require a router implementing `swap_split`; contract-native trust requires the updated router and, for provider fees, a new collector with `swap_split`/`swap_split_to` and automatic trust support. Publishing this SDK does not upgrade deployed contracts.

Version `0.6.0` adds canonical limit-order registry reads, on-chain placement/cancellation, unsigned fill preparation, and single-signature receive trustlines for verified classic assets. Trust is automatic for eligible receive tokens; the public opt-in flag has been removed. Missing-line detached fills require a settlement running the automatic-trust contract. Python also exposes typed HTTP status and Retry-After metadata for caller-controlled rate-limit handling. See the language READMEs for trusted deployment configuration and the network-capped lifetime. This release has offline fixture coverage; it does not certify a production limit-order deployment.

JavaScript `0.7.0` adds a wallet-facing API on top of those limit-order primitives:
`aqua.limitOrders.prepare()` resolves the ledger window, execution reward, signing
capabilities and receive trustline; `prepared.place()` signs and places the
reviewed order. The same manager provides open orders, cursor-paginated history
and bound order records with cancellation methods. It also enforces the
six-month lifetime and fixes browser signature verification and RPC confirmation
timestamp handling. See the [JavaScript guide](javascript/README.md#limit-orders-javascript)
and [0.7.0 release notes](javascript/CHANGELOG.md#070). Both packages are versioned
`0.7.0`; the wallet-facing manager is JavaScript-only.

Both packages preserve the actual simulation error after a handled trustline
probe and retain automatic restoration data during limit-order fill preparation.
Python also exposes optional safe fill-failure diagnostics.

Stable `0.7.0` includes the features described above. It does not include the
ICE Locker/delegation builders, typed settlement routes, or adaptive resource
retry helpers from `0.7.0-testnet.*` / `0.7.0a*`. Consumers using those APIs must
keep their exact prerelease pin. Stable limit-order fills use the existing
legacy route encoding; a typed-route settlement requires a compatible client.

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
6. **Language parity is a feature.** Shared protocol APIs use matching names and semantics in both packages, enforced by golden fixtures in `testdata/`. Protocol feature releases move in lockstep minor versions; language-specific integration helpers are documented separately.
7. **Authorization is fixed before submission.** Every contract write supplies client-built authorization and simulates in enforcement mode. Simulation supplies resources and fees, never the authorization to sign. Raw calls default to root-only source-account authorization; calls needing nested authorization must supply their complete tree (see the language READMEs). Read and quote simulations may still record authorization, which is never reused for submission.

## Scope of v1

Swaps (both modes), limit-order placement, cancellation and registry history, provider-fee collectors and separate output recipients, pool discovery, deposit/withdraw/claim, positions overview, trustline and friendbot helpers. Explicitly out: wallet and key management, price oracles, governance/ICE, SDEX rewards, general historical analytics.

## Releases

Tags trigger publishing: `py-v*` → PyPI, `js-v*` → npm. Independent patches, lockstep minors.

There are two channels:

- **Stable**: `js-vX.Y.Z` / `py-vX.Y.Z`, tagged on `master`. npm publishes it as `latest`.
- **Testnet**: `js-vX.Y.Z-testnet.N` / `py-vX.Y.ZaN`, tagged on the `testnet` branch. Use it to try a new feature on Stellar testnet before the stable `X.Y.Z`. npm publishes it under the `testnet` dist-tag, and pip installs a pre-release only when it is pinned, so it never reaches someone installing the stable version. Pin the exact version: `npm install @aquariusdefi/sdk@X.Y.Z-testnet.N`, `pip install aquarius-sdk==X.Y.ZaN`.

A feature branch does not change the package version. It is merged into `testnet`, where the testnet version is set and tagged, and it reaches `master` through its own pull request. Several features can be on testnet at once without competing prerelease numbers.

Release preparation sets the stable version explicitly. For `0.7.0`, keep the
root Git-install manifest, `javascript/package.json`, the JavaScript lockfile,
`python/pyproject.toml` and `aquarius.__version__` in sync. After the release PR is
merged and its checks pass, tag the resulting `master` commit as `js-v0.7.0` and
`py-v0.7.0`. The release workflows check each tag against its package version and
publish `javascript/` to npm and `python/` to PyPI. Consumers using a temporary
Git dependency for these stable APIs should switch to `@aquariusdefi/sdk@0.7.0`
after publication and regenerate their lockfile.

## Development

- Python: `cd python && pip install -e .[dev] && pytest`
- TypeScript (Node.js >=22.12): `cd javascript && npm ci && npm run typecheck && npm test`
- Fixtures in `testdata/` include recorded API data and synthetic offline Protocol 30 XDR; provenance is documented in each fixture. When a wire contract changes, update both language suites in the same PR.

## Maintenance

[misty-forest](https://github.com/misty-forest) maintains the Aquarius SDK, including security review, vulnerability remediation, and ongoing development.
