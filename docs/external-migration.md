# External Migration Discovery (Aave / Morpho)

How Lite discovers wallet positions on Aave v3 and Morpho that can migrate into
Euler, and the constraints that keep scans fail-isolated and chain-aware.

UI handoffs live under `docs/design/migrate-tab-handoff.md` and
`docs/design/migrate-out-handoff.md`. This page covers the engineering contract
behind `composables/useExternalMigrationPositions.ts`.

## Intent

Portfolio **Migrate** (inbound) and position **migrate out** flows need a
cached list of external positions for the connected owner + active chain.
Discovery runs on Portfolio load (and on forced refresh after a successful
migration) so tab visibility and counts are ready without an extra click.

## Sources

| Source | How Lite finds positions | Gate |
|--------|--------------------------|------|
| **Aave V3** | On-chain pool reads via the SDK Aave connector (reserves, balances, metadata) | Self-gates on connector pool presence for the chain |
| **Morpho markets / MetaMorpho vaults** | Indexed GraphQL via `/api/internal/proxy/morpho` | `MORPHO_MIGRATION_SUPPORTED_CHAIN_IDS` only |

```ts
// entities/migration/constants.ts
MORPHO_MIGRATION_SUPPORTED_CHAIN_IDS = {
  1,     // Ethereum
  130,   // Unichain
  143,   // Monad
  999,   // HyperEVM
  8453,  // Base
  42161, // Arbitrum
}
```

Unsupported Morpho chains return `[]` (nothing to migrate) instead of surfacing
an upstream indexer error. Aave needs no equivalent allowlist — missing pool
config simply yields no candidates.

## Aave position shapes

For each supplied asset on the user's Aave pool:

- **Borrow pairs** — collateral enabled + outstanding variable debt → one
  candidate per (collateral, debt) pair.
- **Supply-only** — collateral not enabled as collateral, **or** no borrowed
  assets on the account → candidate with `debt: null` (Migrate still allowed;
  debt cell shows supply-only in the UI).
- **Stable debt** — candidate is emitted with
  `disabledReason: 'Aave stable debt migration is not supported yet.'`

Supply-only discovery is intentional: users holding aTokens without debt can
still move supply into Euler.

## Failure isolation

Aave discovery fans out reserve / balance / metadata / price reads. Individual
asset failures are logged and **skipped** so one bad token cannot discard the
whole scan:

- Reserve discovery failures isolate per reserve.
- Balance read failures isolate per asset.
- ERC-20 `symbol` / `decimals` multicall failures skip that asset's metadata
  (and therefore its candidates) without aborting siblings.

Top-level Morpho vs Aave loads use `Promise.allSettled`:

- One source failing while the other succeeds → positions from the healthy
  source are kept; failed protocol name goes into `unavailableSources`
  (`'Aave V3' | 'Morpho'`).
- Both failing (or the only source failing with empty results) → `error` is set
  and the list clears.
- Generation / owner+chain guards drop stale responses after wallet or network
  switches.

## Caching and refresh

Module state is keyed by `{ owner, chainId }`:

- Re-entry with the same key while loaded or in-flight is a no-op unless
  `load({ force: true })`.
- Owner/chain change resets the list before the new scan.
- Successful batch / migrate executions that tagged
  `refreshExternalMigrationPositions` bump
  `externalMigrationRefreshCounter` so watchers force-reload.

## Related execution

Outbound / inbound migration **authorization** (aToken approvals, debt
delegation, Morpho authorizations) is planned by the SDK and presented through
`utils/migrationAuthorizationTxs.ts`. On Safe wallets those grants/revokes ride
inside the atomic proposal — see [Safe Wallet Compatibility](./safe-wallets.md).

## Pitfalls

| Symptom | Likely cause |
|---------|----------------|
| Morpho empty on a live Morpho chain | Chain missing from `MORPHO_MIGRATION_SUPPORTED_CHAIN_IDS`, or proxy/indexer error (check `unavailableSources`) |
| Aave supply missing from Migrate | Metadata/balance isolation skipped the asset — check `externalMigration/aave*` warn logs |
| Whole tab errors when only Morpho is down | Should not happen after allSettled isolation; verify both results rejected |
| Stale positions after migrate | Missing `refreshExternalMigrationPositions` on the cart entry / flow |

## Tests

- `tests/composables/useExternalMigrationPositions.test.ts` — supply-only Aave,
  Morpho chain gating, per-stage isolation, allSettled partial failure

## Files

| File | Purpose |
|------|---------|
| `composables/useExternalMigrationPositions.ts` | Discovery, cache, unavailableSources |
| `entities/migration/constants.ts` | Connector ids + Morpho chain allowlist |
| `server/api/internal/proxy/morpho/` | Morpho GraphQL proxy |
| `server/api/internal/proxy/aave/` | Aave helper proxy (where used) |
| `utils/migrationAuthorizationTxs.ts` | Grant/revoke encode + review steps |
| `pages/portfolio/migrate.vue` | Inbound Migrate tab |
| `pages/position/[number]/migrate.vue` | Outbound migrate ceremony |
