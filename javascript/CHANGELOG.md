# JavaScript SDK changelog

## 0.7.0

### Added

- Validated staged split-swap plans and explicit fixed-authorization builders
  for `router.swap_split`, including shared stages, provider fees and recipients,
  optional native receive trust, and network resource checks.
- `assembleTransaction()` to apply configured CPU and resource-fee headroom to
  an existing simulation without signing, submitting or simulating again.
- A wallet-facing `aqua.limitOrders.prepare()` / `prepared.place()` flow over the
  existing limit-order protocol. Preparation resolves the execution reward,
  ledger window, account signing policy and receive trustline before user review.
- An immutable order summary with the approved amounts, reward, expiration,
  signing method and trustline timing.
- Optional `Signer.signAuthEntry` support. Single-signature accounts with a
  capable signer use detached authorization; transaction-only wallets and
  multisig accounts use transaction placement. User rejection does not switch
  to another signing path.
- `open()`, completion-sorted cursor `history()`, `get()` and bounded `list()`
  methods returning the same bound order model with cancellation/fill methods.
- Adapters for existing external-signature and restoration flows. Pending
  signatures return `PENDING_SIGNATURES`, not an open-order confirmation.
- Settlement-fill decoding helpers for execution notifications, including
  actual amounts for classic and contract-only Soroban tokens.
- Direct installation from a commit-pinned Git URL and a local package helper
  for testing before publication. npm releases still come from `javascript/`.

### Changed

- Enforce the 180-day maximum and 3,110,399-ledger allowance window before draft
  creation or signing, including legacy and imported orders. A lower settlement
  limit still applies.
- Wallet placement preserves verified remaining allowances and atomically
  guards their approved totals, the execution reward and the unused order ID.
  Reviewed conditions are checked again before placement.
- Retrying the same prepared order reuses its signed proof or transaction and
  coalesces concurrent placement calls. A new `prepare()` creates a new order.
- Update the testnet provider-fee collector factory preset to the current
  deployment, matching the main branch's network configuration.

### Fixed

- Classify failed simulations from their terminating diagnostics or error log
  entries, so a handled missing-trustline probe does not mask the actual error.
- Preserve automatic restoration data in successful limit-order fill
  simulations instead of rejecting them because a restore preamble is present.
- Normalize byte arrays during browser signature verification so transaction
  signing does not fail with `Argument must be a Buffer`.
- Accept RPC confirmation timestamps supplied as decimal strings, avoiding a
  false `The placement transaction is not confirmed yet` error for a confirmed
  placement. Receipt hashes and confirmation metadata remain validated.
- Include the repository's Apache-2.0 license text in the published npm package.

### Compatibility

- Limit orders already existed in `0.6.0`; this release adds wallet integration
  and validation improvements. Existing programmatic APIs remain available.
- Node.js >=22.12 and the `@stellar/stellar-sdk ^17.4.0` peer dependency are
  unchanged. Amounts use `bigint` base units.
- Python also releases as `0.7.0`, with matching split-swap, simulation-error and
  automatic-restoration behavior plus optional safe fill-failure diagnostics.
  The wallet-facing manager is JavaScript-only.
- Split swaps require a compatible router; provider splits and native trust
  require compatible collector contracts. Ordinary swaps remain unchanged.
- ICE Locker/delegation builders, typed settlement routes and adaptive resource
  retry helpers from `0.7.0-testnet.*` / `0.7.0a*` are not included. Consumers of
  those APIs must retain an exact prerelease pin. Stable fills keep legacy route
  encoding.
- After publication, applications using a Git URL or local tarball should pin
  `@aquariusdefi/sdk@0.7.0` and regenerate their dependency lockfile. See the
  [migration guide](README.md#upgrading-from-060-or-a-git-dependency).
