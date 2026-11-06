# Golden fixtures

Recorded responses and encodings that both language test suites consume. They pin the
external contracts the SDK depends on — the find-path API shape, XDR encodings, and
transaction-meta layouts.

| File | What it pins | Recorded |
| --- | --- | --- |
| `protocol_30.json` | Synthetic old/new SCAddress, W addresses, CAP-88 ledger headers, signed auth/envelopes, meta v3/v4 and RPC v30 event wire data; generated in pinned Python, cross-decoded in JavaScript | 2026-10-23, offline |
| `find_path_testnet_xlm_aqua.json` | `/find-path/` response shape (success case, 3-hop route) | 2026-07-13, testnet API |
| `simulation_error_after_handled_probe.json` | Synthetic simulation #2006 after a handled missing-trustline probe, shared by both submission-engine regression suites | Offline |
| `diagnostic_events_missing_trustline.json` | DiagnosticEvent XDRs from a swap simulation that failed on a missing trustline (error #13 + the trustline text marker) | 2026-07-13, testnet RPC |

Policy: when an upstream contract changes, re-record the fixture and adapt both parsers
in the same PR. A fixture change with only one language's parser touched is a red flag.
