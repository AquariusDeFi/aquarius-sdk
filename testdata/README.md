# Golden fixtures

Recorded responses and encodings that both language test suites consume. They pin the
external contracts the SDK depends on — the find-path API shape, XDR encodings, and
transaction-meta layouts.

| File | What it pins | Recorded |
| --- | --- | --- |
| `protocol_30.json` | Synthetic old/new SCAddress, W addresses, CAP-88 ledger headers, signed auth/envelopes, meta v3/v4 and RPC v30 event wire data; generated in pinned Python, cross-decoded in JavaScript | 2026-10-23, offline |
| `find_path_testnet_xlm_aqua.json` | `/find-path/` response shape (success case, 3-hop route) | 2026-07-13, testnet API |
| `diagnostic_events_missing_trustline.json` | DiagnosticEvent XDRs from a swap simulation that failed on a missing trustline (error #13 + the trustline text marker) | 2026-07-13, testnet RPC |
| `split-plans.json` | `/find-path-split/` response bodies rendered by the backend serializer from synthetic constant-product pools over testnet SAC tokens: single chain, parallel split, shared-prefix diamond, prefix and suffix, plans at and over the stage, part and hop limits, no route; golden `swap_split` and trust-batch operations encoded from each `stages_xdr` with stellar-sdk primitives | 2026-11-05, offline |
| `split-behavior.json` | Amount, minimum, plan-validation and builder cases; each plan rejection is a change to a recorded plan | 2026-11-05, offline |
| `split-resources.json` | Network-limit, footprint, configuration and return-value cases around the diamond plan's transaction | 2026-11-05, offline |

Policy: when an upstream contract changes, re-record the fixture and adapt both parsers
in the same PR. A fixture change with only one language's parser touched is a red flag.
