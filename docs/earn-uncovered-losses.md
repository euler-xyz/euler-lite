# Earn Uncovered Losses

This document describes how Euler Lite surfaces **Uncovered losses** on EulerEarn vault overview Statistics.

## Intent

When an Earn strategy realises bad debt or is force-removed, EulerEarn records a shortfall. Coverage is donated by supplying on behalf of the canonical coverage address (`address(1)`). Share price does not drop instantly — the full loss stays counted in total supply — so the UI needs a separate figure for the still-unbacked portion.

Lite labels that figure **Uncovered losses** (not raw "Lost assets") and shows it next to Total supply and Available liquidity.

## Architecture

```
EulerEarn lens / V3 detail
  lostAssets  (already net of coverage shares at address(1))
        │
        ▼
  SDK eulerEarnService adapters
  (on-chain + V3 pass the lens/API value through)
        │
        ▼
  vault.lostAssets on EulerEarn entity
        │
        ▼
  VaultOverviewEarnBlockStats.vue
  formatAssetValue(lostAssets, vault, 'off-chain')
        │
        ├─ hasPrice → formatCompactUsdValue(usdValue)
        └─ else     → asset-denominated display string
```

There is **no** Lite-side `balanceOf(address(1))` read and no local netting helper. An earlier coverage-RPC path was removed because the lens already subtracts `convertToAssets(balanceOf(address(1)))` before exposing `lostAssets`; reading coverage again double-counted and understated the shortfall.

## Display path

| Piece | Role |
| ----- | ---- |
| `components/entities/vault/overview/earn/VaultOverviewEarnBlockStats.vue` | Statistics accordion row + tooltip |
| `utils/sdk-prices.ts` → `formatAssetValue` | Same off-chain USD path as Total supply / Available liquidity |
| `utils/race-guard.ts` → `runGuarded` | Drops stale async formatter results when the effect re-runs |
| `data-field="Uncovered losses"` / `:data-value="vault.lostAssets.toString()"` | Parity / scraper hooks |

Initial display is `'-'` until the first guarded format commits. Healthy vaults with `lostAssets === 0n` render as `$0` (or the zero asset amount when unpriced).

## Semantics engineers must keep

1. **Treat `vault.lostAssets` as already uncovered.** Do not subtract coverage shares in Lite. Both SDK adapters preserve the normalized lens/API value.
2. **Keep the formatter race-guarded.** `formatAssetValue` is async; without `runGuarded`, a slow earlier call can overwrite a fresher amount after vault or price updates.
3. **Preserve scraper attributes.** Downstream parity scrapers key off `data-field` / `data-value`.
4. **Tooltip copy** explains that total supply still includes the full loss so share price does not gap down; the row is only the currently unbacked slice.

## Constraints

- Applies to **EulerEarn** overview stats only (`EulerEarn` entity). EVK / Securitize overview blocks do not show this row.
- Pricing uses the vault's `marketPriceUsd` off-chain field via `formatAssetValue(..., 'off-chain')`. When that price is missing, the row falls back to the asset amount + symbol string (same pattern as neighbouring rows).
- Lite does not invent a second source of truth for coverage. If upstream lens/V3 semantics change, update this doc and the component comment together.

## Tests

| Test | What it locks |
| ---- | ------------- |
| `tests/utils/sdk-prices.test.ts` ("preserves the normalized uncovered-loss amount…") | Six-decimal live amount formats without truncation drift |
| `tests/utils/race-guard.test.ts` (`runGuarded` out-of-order case) | Stale formatter commits are dropped |

## Pitfalls

| Symptom | Likely cause |
| ------- | ------------ |
| Covered vault still shows a large positive uncovered loss | Upstream returned gross `lostAssets`, or a local re-net was reintroduced incorrectly |
| Uncovered loss understated vs explorer/lens | Lite (or a wrapper) subtracted `address(1)` coverage a second time |
| Row flickers or regresses to an older amount after navigation | Formatter effect not going through `runGuarded` |
| Parity scraper misses the row | `data-field` / `data-value` removed or renamed |
