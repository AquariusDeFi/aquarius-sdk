# Golden fixtures

Recorded responses and encodings that both language test suites consume. They pin the
external contracts the SDK depends on — the find-path API shape, XDR encodings, and
transaction-meta layouts.

| File | What it pins | Recorded |
| --- | --- | --- |
| `find_path_testnet_xlm_aqua.json` | `/find-path/` response shape (success case, 3-hop route) | 2026-07-13, testnet API |

Policy: when an upstream contract changes, re-record the fixture and adapt both parsers
in the same PR. A fixture change with only one language's parser touched is a red flag.
