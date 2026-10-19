# Pricing System Architecture

Euler Lite uses the Euler V2 SDK as the pricing source. The app keeps a small compatibility layer in `utils/sdk-prices.ts` so UI call sites can ask for asset prices, collateral prices, USD values, and conservative oracle ratios through a Lite-shaped API.

The important rule is that Lite's explicit `source` argument maps to SDK fields whose names already encode the source or context.

## Source Mapping

| Lite call | SDK-backed source | Purpose |
|----------|-------------------|---------|
| `getAssetOraclePrice(vault)` | SDK `getAssetOraclePrice(vault)` | Raw EVault asset oracle price in the vault unit of account |
| `getCollateralOraclePrice(liabilityVault, collateralVault)` | SDK `getCollateralOraclePrice(liabilityVault, collateralVault)` | Raw collateral oracle price from the liability vault's perspective |
| `getAssetUsdPrice(vault, 'off-chain')` | `vault.marketPriceUsd` | Display price for a vault asset |
| `getCollateralUsdPrice(liabilityVault, collateralVault, 'off-chain')` | `liabilityVault.collaterals[].marketPriceUsd` | Display price for collateral in a borrow context |
| `getAssetUsdValue(...)` | amount multiplied by `vault.marketPriceUsd` | Display USD value for supplied, borrowed, or listed vault assets |
| `getCollateralUsdValue(...)` | amount multiplied by the matching collateral edge `marketPriceUsd` | Display USD value for collateral where the borrow vault chooses the price source |
| `getTokenUsdPrice(address)` | `sdk.priceService.fetchAssetUsdPriceByAddress(...)` | Display price for arbitrary wallet/swap tokens that are not loaded vault entities |

Borrow-position aggregates use SDK precomputed position fields. Portfolio borrow cards render NAV, Net APY, and ROE from the SDK portfolio position instead of recomputing those values with local price helpers.

For SDK account and portfolio properties, numerical fields whose names include `Usd` are market-priced USD values. Oracle and risk-unit values stay in explicit oracle and liquidity fields such as `oraclePriceRaw`, `assetRiskPrice`, `liabilityValue`, and `totalCollateralValue`.

| UI value | SDK-backed field |
|----------|------------------|
| Total collateral value | `position.totalCollateralValueUsd` |
| Per-collateral value in borrow context | `position.borrow.liquidity.collaterals[].valueUsd` |
| Borrow market value | `position.borrow.borrowedValueUsd` |
| Borrow-position Net APY | `position.netApy` |
| Borrow-position ROE | `position.roe` |
| Primary collateral liquidation price | `position.primaryCollateralLiquidationPrice` |
| Borrow liquidation price | `position.borrowLiquidationPriceUsd` |

## Backend Configuration

Pricing backend configuration is SDK-owned. Lite builds the SDK without a pricing backend override, so the SDK uses its defaults.

The SDK instance cache key includes RPC URLs, the V3 URL, labels URLs, and the deployment URL. Changing any of those inputs rebuilds the SDK instance.

## Liability-Vault Collateral Pricing

Collateral pricing is context-sensitive. When a borrow vault accepts a collateral vault, Lite must use the borrow vault's collateral edge, not the collateral vault's own asset price.

```ts
getCollateralUsdPrice(borrowVault, collateralVault, 'off-chain')
```

This resolves to:

```ts
borrowVault.collaterals.find(
  collateral => collateral.address === collateralVault.address,
)?.marketPriceUsd
```

That matches protocol semantics: the liability vault's oracle decides how accepted collateral is priced for the borrow position.

## Oracle and Ratio Calculations

Health, LTV, max-borrow, max-withdraw, and liquidation-sensitive form calculations continue to use raw SDK oracle helpers:

```ts
const collateralPrice = getCollateralOraclePrice(borrowVault, collateralVault)
const borrowPrice = getAssetOraclePrice(borrowVault)
const ratio = conservativePriceRatio(collateralPrice, borrowPrice)
```

`conservativePriceRatio()` uses the conservative collateral-bid versus liability-ask ratio:

```ts
ratio = collateralBid / liabilityAsk
```

Those calculations stay independent from market display prices.

## Display Fallbacks

USD helpers return `undefined` when the SDK field is missing. UI wrappers use `toUsdAmount()` or `get*OrZero()` depending on whether the component needs to distinguish missing prices from true zero values.

Use `toUsdAmount(undefined)` when the UI should show the token amount instead of a USD value. Use `getAssetUsdValueOrZero()` only in aggregate/list contexts where missing prices should not block rendering.

Form-time Net APY and ROE previews use the same liability-context USD values to weight every collateral in a position. See [Projected Yield](./projected-yield.md) for the utilization simulation, completeness rules, and metric formulas.

Oracle-adapter cards quote via EVC `batchSimulation`, not these USD helpers. See [Oracle Adapter Display](./oracle-adapter-display.md).

EulerEarn Statistics uses the same off-chain `formatAssetValue` path for Total supply, Available liquidity, and Uncovered losses. See [Earn Uncovered Losses](./earn-uncovered-losses.md) for why `vault.lostAssets` must not be re-netted in Lite.

## Unpriced and partial USD

A missing `marketPriceUsd` is not a zero. Listing cards, market totals, USD filters, and portfolio aggregates must say so rather than treating the SDK's priced-only sum as complete.

```text
vault.marketPriceUsd / position.*Usd
        │
        ▼
hasPrice? ──no──► token amount + VaultNoUsdPriceHint
        │
       yes
        ▼
USD cell / add into group and portfolio totals
        │
        ▼
allVaultsPriced / portfolioPricingGaps
        │
        ├── MarketPartialPricingHint on Explore market cards
        ├── USD custom filters skip the comparison (keep the row)
        └── Portfolio "Partial pricing" on supplied / borrowed / NAV
```

### Vault rows

`VaultItem`, `VaultEarnItem`, and `VaultBorrowItem` fall back to token amounts when the USD price for the displayed supply or liquidity metric is unavailable. They show `VaultNoUsdPriceHint` ("This asset has no USD price right now, so amounts show in tokens.") next to the affected metric label. Do not swap that hint for a `$0`.

### Market groups

`useMarketGroups` sums only vaults with a priced USD value and sets `metrics.allVaultsPriced` false when any member is unpriced. `DiscoveryMarketCard` (Explore only) then shows `MarketPartialPricingHint` ("Some vaults in this market have no USD price, so these totals leave them out."). A vault with `totalAssets === 0` is treated as priced (`$0`) and does not mark the market partial.

`marketUsdMetricValue(metrics, metric)` in `utils/market-usd-metric.ts` returns `undefined` unless `allVaultsPriced`. Explore's USD chips (`totalTVL`, `totalBorrowed`, `totalAvailableLiquidity`) go through that helper so a partly priced market's lower-bound total cannot satisfy or fail "TVL > X".

`useCustomFilters` **keeps** a row when a USD metric has no comparable number (`undefined` / `NaN`), on Explore, Lend, Borrow, and Earn. Lend and Earn omit unpriced vaults from their USD maps; Borrow stores `undefined`. Percent metrics such as Max ROE still drop rows whose value is not a finite number unless `includeWhenValueUnavailable` is set.

### Portfolio totals

SDK `totalSuppliedValueUsd` / `totalBorrowedValueUsd` / `netAssetValueUsd` sum **priced** positions only. `portfolioPricingGaps` in `utils/portfolio-pricing.ts` walks the underlying savings and open borrows so a partial total cannot look complete:

| Flag | True when |
| ---- | --------- |
| `supplied` | A savings row with assets or shares, or a collateral on an open borrow, has a non-finite `suppliedValueUsd` |
| `borrowed` | An open borrow has a non-finite `borrow.borrowedValueUsd` |

`useEulerAccount` exposes those as `hasMissingPrices` on `totalSuppliedValueInfo`, `totalBorrowedValueInfo`, and `netAssetMarketValueInfo` (also true when the SDK total itself is missing while positions exist).

`pages/portfolio.vue`:

- Renders the priced subtotal plus a **Partial pricing** tooltip.
- Shows an em dash when the priced total is `0` and prices are missing (`total === 0 && hasMissingPrices`), so an unpriced-only book does not look like `$0`.
- NAV copy warns extra when **borrowed** value is unpriced: debt left out can make NAV look higher than it is.

### Bad-debt unpriced collateral

V3 `/v3/evk/vaults/bad-debt` may include `unpricedBadDebtUsd` and `unpricedCollateralCount`. `utils/vault-bad-debt.ts` accepts them only when both are present, finite, non-negative, the USD figure does not exceed `badDebtUsd` (with a tiny absolute/relative tolerance), and `(unpricedUsd > 0) === (count > 0)`. Otherwise the hint says the unpriced collateral data is missing or invalid rather than trusting a partial row. Unpriced collateral in that hint is valued at `$0` by upstream — do not re-price it in Lite.

## Tests

| Test | What it locks |
| ---- | ------------- |
| `tests/utils/market-usd-metric.test.ts` | Explore USD filter values are `undefined` unless `allVaultsPriced` |
| `tests/composables/useCustomFilters.test.ts` | USD chips keep unpriced rows; percent chips do not |
| `tests/utils/portfolio-pricing.test.ts` | Gaps on unpriced savings, collateral, and debt; NaN counts as unpriced |
| `tests/composables/useMarketGroupsTvl.test.ts` | Group `allVaultsPriced` after mixed-price members |
| `tests/composables/useEulerAccount.test.ts` | Portfolio `hasMissingPrices` when SDK totals omit unpriced rows |
| `tests/utils/vault-bad-debt.test.ts` | Unpriced-collateral reporting vs invalid/missing payload |
