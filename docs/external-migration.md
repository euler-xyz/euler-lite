# External Migration Discovery (Aave / Morpho)

How Lite discovers wallet positions on Aave v3 and Morpho that can migrate into
Euler, and the constraints that keep scans fail-isolated and chain-aware.

UI handoffs live under `docs/design/migrate-tab-handoff.md` and
`docs/design/migrate-out-handoff.md`. This page covers the engineering contract
behind `composables/useExternalMigrationPositions.ts`.

## Intent

Portfolio **Migrate** (inbound) and position **migrate out** flows need a
cached list of external positions for the connected owner + active chain.
Discovery starts at app root — `app.vue` calls `useExternalMigrationPositions()`
so the scan runs from the same lifecycle as the rest of the shared state — plus
on forced refresh after a successful migration. Portfolio pages consume that
shared state rather than triggering their own scan, so tab visibility and counts
are ready without an extra click.

## Sources

| Source | How Lite finds positions | Gate |
|--------|--------------------------|------|
| **Aave V3** | Direct viem multicalls from `useExternalMigrationPositions.ts` (reserves, user configuration, balances, metadata) against locally declared ABIs; the SDK Aave connector only supplies the pool address | Self-gates on connector pool presence for the chain |
| **Morpho markets / MetaMorpho vaults** | Indexed GraphQL via `/api/internal/proxy/morpho` | `MORPHO_MIGRATION_SUPPORTED_CHAIN_IDS` only |

```ts
// entities/migration/constants.ts
export const MORPHO_MIGRATION_SUPPORTED_CHAIN_IDS: ReadonlySet<number> = new Set([
  1, // Ethereum
  130, // Unichain
  143, // Monad
  999, // HyperEVM
  8453, // Base
  42161, // Arbitrum
])
```

Unsupported Morpho chains return `[]` (nothing to migrate) instead of surfacing
an upstream indexer error. Aave needs no equivalent allowlist — missing pool
config simply yields no candidates.

## Aave position shapes

For each supplied asset on the user's Aave pool:

- **Borrow pairs** — collateral enabled + nonzero **combined** debt (variable +
  stable) → one candidate per (collateral, debt) pair.
- **Supply-only** — collateral not enabled as collateral, **or** no borrowed
  assets on the account → candidate with `debt: null` (Migrate still allowed;
  the row drops the Debt cell entirely — "supply only" appears only in the row's
  aria-label).
- **Stable debt** — candidate is emitted with
  `disabledReason: 'Aave stable debt migration is not supported yet.'`

Supply-only discovery is intentional: users holding aTokens without debt can
still move supply into Euler.

## Failure isolation

Aave discovery fans out reserve / balance / metadata / price reads. Isolation
is **not** "any per-asset failure is skipped." Failed **root** and
**configured-position** reads reject the whole Aave fetch rather than decode
as "no balance":

- **Whole-source reject** — `getReservesList` / `getUserConfiguration` failures;
  `getReserveData` failure (or invalid reserve data) for an asset marked as
  collateral or debt in the user-configuration bitmap; `balanceOf` failure for
  a configured asset, including any variable/stable debt-token read. These
  throw `Aave discovery read failed: <label>` — or
  `Aave discovery read returned invalid reserve data: <asset>` when the reserve
  call succeeded but decoded to an unusable shape — and fail the Aave source
  (Morpho can still succeed via `Promise.allSettled`).
- **Per-asset skip** — unrelated reserve / unconfigured-supply probes (assets
  not set as collateral or debt) are logged and skipped. ERC-20 `symbol` /
  `decimals` failures skip that asset's metadata (and therefore its candidates)
  without aborting siblings. Per-asset USD price failures store `null` and
  still emit the candidate.

Top-level Morpho vs Aave loads use `Promise.allSettled`:

- One source failing while the other returned **at least one position** → those
  positions are kept; the failed protocol name goes into `unavailableSources`
  (`'Aave V3' | 'Morpho'`).
- Any source failing while the merged result is **empty** → the first rejection
  is rethrown, `error` is set and the list clears. A healthy-but-empty source
  does not protect the load: one rejection plus zero surviving positions errors
  the whole scan.
- Generation / owner+chain guards drop stale responses after wallet or network
  switches.

## Caching and refresh

Module state is keyed by `{ owner, chainId }`:

- Re-entry with the same key while loaded or in-flight is a no-op unless
  `load({ force: true })`.
- Owner/chain change resets the list before the new scan.
- `scheduleExternalMigrationRefreshes()` bumps
  `externalMigrationRefreshCounter` four times on a staggered
  `[0, 5s, 15s, 30s]` schedule
  (`POST_EXTERNAL_MIGRATION_REFRESH_DELAYS_MS`) so watchers force-reload past
  indexer lag instead of caching a pre-migration snapshot.
- Batch execution schedules those refreshes only when a cart entry tagged
  `refreshExternalMigrationPositions`. The migrate pages
  (`position/.../migrate`, borrow/swap) call
  `scheduleExternalMigrationRefreshes()` unconditionally after a successful
  migration.

## Related execution

Outbound / inbound migration **authorization** (aToken approvals, debt
delegation, Morpho authorizations) is planned by the SDK and presented through
`utils/migrationAuthorizationTxs.ts`. On Safe wallets those grants/revokes ride
inside the atomic proposal — see [Safe Wallet Compatibility](./safe-wallets.md).

## Pitfalls

| Symptom | Likely cause |
|---------|----------------|
| Morpho empty on a live Morpho chain | Chain missing from `MORPHO_MIGRATION_SUPPORTED_CHAIN_IDS`, or proxy/indexer error (check `unavailableSources`) |
| Aave supply missing from Migrate | Unrelated reserve/supply or metadata skip — check `externalMigration/aave*` warn logs. Configured collateral/debt reserve or balance failures instead reject the whole Aave source (`unavailableSources` / top-level error). |
| Whole tab errors when only Morpho is down | Expected when Aave also yielded zero positions — the surviving source must return at least one position to suppress the rejection |
| Stale positions after migrate | Missing `refreshExternalMigrationPositions` on the cart entry / flow |

## Tests

- `tests/composables/useExternalMigrationPositions.test.ts` — supply-only Aave,
  Morpho chain gating, per-asset skip vs whole-source configured-read
  failures, allSettled partial failure

## Files

| File | Purpose |
|------|---------|
| `composables/useExternalMigrationPositions.ts` | Discovery, cache, unavailableSources |
| `entities/migration/constants.ts` | Connector ids + Morpho chain allowlist |
| `server/api/internal/proxy/morpho.post.ts` | Morpho GraphQL proxy |
| `server/api/internal/proxy/aave.post.ts` | Aave GraphQL proxy the SDK Aave connector is configured with (not used by discovery's on-chain reads) |
| `utils/migrationAuthorizationTxs.ts` | Grant/revoke encode + review steps |
| `pages/portfolio/migrate.vue` | Inbound Migrate tab |
| `pages/position/[number]/migrate.vue` | Outbound migrate ceremony |
