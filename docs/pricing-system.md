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

| UI value | SDK-backed field |
|----------|------------------|
| Total collateral value | `position.totalCollateralMarketValueUsd` |
| Per-collateral value in borrow context | `position.borrow.liquidity.collaterals[].marketValueUsd` |
| Borrow market value | `position.borrow.borrowedMarketValueUsd` |
| Borrow-position Net APY | `position.netApy` |
| Borrow-position ROE | `position.roe` |
| Primary collateral liquidation price | `position.primaryCollateralLiquidationPrice` |
| Borrow liquidation price | `position.borrowLiquidationPriceUsd` |

## Backend Configuration

Pricing backend configuration is SDK-owned. Lite builds the SDK without a pricing backend override, so the SDK uses its defaults.

The SDK instance cache key includes RPC URLs, labels URLs, deployment URL, and oracle-checks URL. Changing any of those inputs rebuilds the SDK instance.

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
