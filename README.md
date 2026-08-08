# Aquarius SDK

Official SDKs for building on [Aquarius](https://aqua.network) — swaps, liquidity, and rewards on Stellar, in Python and TypeScript.

**Status: 0.3.x.** Swaps (quote → execute in both modes) and the liquidity lifecycle — pool discovery, deposit, withdraw, rewards, positions — are complete in both languages, each verified end to end with real testnet transactions. Concentrated liquidity position management (range deposits, withdrawals, fee claims, position reads) is available as a **beta** surface: the concentrated contracts are under an ongoing external audit, and router deposits into concentrated pools remain refused — ranges are managed through the pool contract directly. Provider-fee collectors — routing swaps through your own fee-taking contract, deploying one, and claiming what it accumulates — ship in the next minor release.

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

## Design principles

1. **Two-phase everything.** `quote()` → `Quote.execute()`. UIs show before they commit; the quote object carries everything needed to execute, so what you quoted is what you execute.
2. **Reads never need a signer.** Writes take one injected signer abstraction — a `Keypair` or a wallet-adapter callback. The SDK never accepts a raw secret string where avoidable and never stores keys.
3. **Escape hatches at every layer.** `Quote.buildTransaction()` returns unsigned XDR; `client.contract.call()` invokes the router raw; `client.api` is the typed REST client. The SDK wraps, it never traps.
4. **Protocol details are the SDK's problem.** `swaps_chain` encoding, token-vector sorting, pool hashes, transaction meta v3/v4, u128 conversion — none of these exist in the public surface.
5. **Typed errors that encode what we know.** Guard failures raise `SlippageError` ("re-quote and retry"), kill switches raise `PausedError` ("not your bug"), missing routes raise `NoRouteError`.
6. **Language parity is a feature.** Same names, same semantics in both packages, enforced by shared golden fixtures in `testdata/`. Feature releases move in lockstep minor versions (`py-v0.4.x` and `js-v0.4.x` have the same surface).

## Scope of v1

Swaps (both modes), provider-fee collectors and separate output recipients, pool discovery, deposit/withdraw/claim, positions overview, trustline and friendbot helpers. Explicitly out: wallet and key management, price oracles, governance/ICE, SDEX rewards, historical data.

## Releases

Tags trigger publishing: `py-v*` → PyPI, `js-v*` → npm. Independent patches, lockstep minors.

## Development

- Python: `cd python && pip install -e .[dev] && pytest`
- TypeScript: `cd javascript && npm install && npm run typecheck`
- Fixtures in `testdata/` are recorded from the live testnet API; when the API contract changes, re-record them in the same PR that adapts the parsers — both languages, one PR.
