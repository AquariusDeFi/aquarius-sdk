# @aquariusdefi/sdk

The TypeScript SDK for [Aquarius](https://aqua.network) — swaps, liquidity, and rewards on Stellar.

**Status: interface preview (0.0.x).** This package publishes the typed API surface for design review — method bodies are not implemented yet and throw. For working integrations today, use the [Python SDK](https://pypi.org/project/aquarius-sdk/) (`pip install aquarius-sdk`, working swap surface) or the [developer documentation](https://docs.aqua.network/developers/quickstart).

The surface being built, in TypeScript terms:

```ts
import { AquariusClient, Asset, XLM } from "@aquariusdefi/sdk";

const aqua = new AquariusClient({ network: "testnet", signer });

const quote = await aqua.quote({ from: XLM, to: AQUA, amountIn: 100_0000000n });
const receipt = await quote.execute();
```

- Two-phase `quote()` → `execute()`; reads need no signer.
- Typed errors: `SlippageError` (re-quote and retry), `NoRouteError`, `PausedError`.
- Amounts are `bigint` stroops throughout.
- Escape hatches at every layer: `quote.buildTransaction()` returns unsigned XDR.

Questions and integration help: [Discord](https://discord.gg/sgzFscHp4C).
