# End-to-end tests

Live-network tests for both SDK languages, born out of the 0.2.x mainnet test
campaign that surfaced the txBAD_SEQ, retry-backoff, and misdiagnosis bugs.
Unit tests (in `python/tests/` and `javascript/tests/`) stay fast and
network-free; everything here talks to real networks and, in one case, moves
real (tiny) funds. The one exception is `test_probe_fixture.py`, the offline
tests of the probe fixture script, which CI runs with the unit tests.

Python scripts live here (they import the installed `aquarius` package from
anywhere); the JavaScript mirrors live in `javascript/e2e/` so they resolve
`@stellar/stellar-sdk` from the package's own `node_modules`.

| Script | Network | Funds | When it runs in CI |
| --- | --- | --- | --- |
| `testnet_lifecycle.py` / `javascript/e2e/…mjs` | testnet | throwaway (friendbot) | every PR and master push |
| `mainnet_readonly.py` / `javascript/e2e/…mjs` | mainnet | none — reads only | every PR and master push |
| `mainnet_lifecycle.py` | mainnet | ~1.5 XLM in play, returned minus fees | nightly + manual dispatch only |
| `probe_fixture.py` | mainnet | up to 3.5 XLM, mostly kept as USDC and LP shares | manual dispatch of `probe-fixture.yml` only |

## The testnet lifecycle

Generates a fresh keypair, funds it with friendbot, and exercises the whole
surface: trustline, exact-input and exact-output swaps (with the SDK's retry
backoff absorbing indexer lag), the unsigned-XDR escape hatch, pool discovery,
deposit, position reads, withdraw, claim, and the error paths (ambiguous
amounts, concentrated-deposit refusal).

## The mainnet lifecycle

Swap 1 XLM → AQUA, deposit 0.5 XLM + matching AQUA into the deep volatile
pool, read the position, withdraw, swap everything back. Asserts no AQUA is
left dangling and that the run cost less than 0.2 XLM. Resumable: if a
previous run died mid-flow, the next one picks up the leftover AQUA instead
of buying more.

It needs `MAINNET_E2E_SECRET` — a **dedicated** account, not anyone's personal
wallet, holding ~15 XLM:

```bash
python -c "from stellar_sdk import Keypair; k = Keypair.random(); print(k.public_key); import pathlib; pathlib.Path('ci-wallet-secret.txt').write_text(k.secret)"
# fund the printed address with ~15 XLM, then:
gh secret set MAINNET_E2E_SECRET < ci-wallet-secret.txt && rm ci-wallet-secret.txt
```

Without the secret the script (and the CI job) skips cleanly, so forks and
fresh clones are unaffected.

Never run two mainnet lifecycles concurrently — they trade against each other
(learned the hard way: two overlapping runs produced interleaved deposits and
one instance swept the other's AQUA mid-flow). CI serializes the job with a
non-cancelling concurrency group; locally, just don't.

## The probe wallet fixture

The Aquarius availability exporter simulates a 0.1 XLM deposit into and a
small withdraw from the XLM/USDC 0.10% pool from the mainnet lifecycle wallet.
Those simulations need a USDC trustline, free USDC and LP shares in that pool;
`probe_fixture.py` checks that fixture and creates what is missing. Run it
through the `Probe fixture` workflow (manual dispatch), in this order:

1. `check` — read-only, no secret; red while the fixture is incomplete;
2. `plan` — dry run: the planned steps, amounts, fees and guards; submits nothing;
3. `execute` — signs and submits the plan (at most 3.5 XLM including reserve and fees);
4. `check` again — green once the exporter's simulations pass.

The workflow shares the `mainnet-e2e` concurrency group with the lifecycle
jobs, so it never runs at the same time as them. Locally:
`python e2e/probe_fixture.py --check` needs no secret; `--help` lists every
mode and safety check.
