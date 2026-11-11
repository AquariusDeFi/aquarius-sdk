# JavaScript SDK changelog

## 0.6.1

### Added

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
- Python remains on `0.6.0`; the wallet-facing manager is JavaScript-only.
- The separate `0.7.0-testnet.*` features are not part of this stable patch.
- After publication, applications using a Git URL or local tarball should pin
  `@aquariusdefi/sdk@0.6.1` and regenerate their dependency lockfile. See the
  [migration guide](README.md#upgrading-from-060-or-a-git-dependency).
