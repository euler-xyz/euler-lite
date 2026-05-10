# Pricing System Architecture

This document describes the pricing system in euler-lite, including how prices are fetched, converted to USD, and how Pyth oracles are handled.

## Overview

The pricing system is built as a 3-layer architecture that separates concerns between raw oracle data, USD conversion, and value calculation.

## Price Sources: On-Chain vs Off-Chain

The pricing functions support two price sources:

| Source | Description | Use Case |
|--------|-------------|----------|
| `'on-chain'` (default) | Uses on-chain oracle data only | Health factor, LTV, liquidation calculations |
| `'off-chain'` | Tries backend first, falls back to on-chain | Display values, portfolio totals, UI |

**Key insight**: The UoA rate **always tries backend (off-chain) first**, then falls back to on-chain — regardless of the caller's `source` parameter. Since UoA is a common denominator (both collateral and borrow prices are quoted in UoA), using an off-chain UoA rate doesn't affect health factor/LTV ratios - it only changes the USD display values. This means callers don't need to think about UoA sourcing at all.

### Backend Configuration

Configure the backend URL via environment variable:

```bash
# In .env or Doppler
EULER_API_URL=https://your-euler-api.com  # Empty = prices disabled (on-chain only)
```

Use `usePriceBackend()` composable to access the configuration:

```typescript
const { backendConfig, isBackendEnabled } = usePriceBackend()

// Pass to price functions
const price = await getAssetUsdPrice(vault, 'off-chain', backendConfig.value)
```

### Backend Client Implementation

The backend client (`services/pricing/backendClient.ts`) provides price fetching with automatic optimizations:

**Types:**
- `BackendPriceData` - Response shape: `{ chainId, address, symbol, priceUsd: number, source, timestamp: string }`

**API Endpoint:**
- URL: `GET /v3/prices?chainId={chainId}&addresses={addr1},{addr2},...`
- Response: `{ data: BackendPriceData[], meta: { ... } }`
- Max 100 addresses per request (chunked automatically)

**Caching:**
- TTL: 60 seconds
- Key format: `{chainId}:{address.toLowerCase()}`
- Stale entries cleared automatically

**Request Batching:**
- 100ms debounce window
- Requests grouped by chainId
- Addresses deduplicated within batch

**Error Handling:**
- Network errors: Log warning, return cached results if available
- Non-200 responses: Fall back to cached results
- Partial failures: Return available cached data

**Key Functions:**
- `fetchBackendPrice(address, chainId?)` - Single price with auto-batching
- `fetchBackendPrices(addresses, chainId?)` - Multiple prices
- `backendPriceToBigInt(price)` - Convert to 18-decimal bigint

### Price Source Usage in Codebase

#### On-Chain Only (Layer 1 - Synchronous)

These functions are **always on-chain** and used for **liquidation-sensitive calculations**:

| Function | Purpose | Used For |
|----------|---------|----------|
| `getAssetOraclePrice()` | Raw oracle price in UoA | Health factor, LTV calculations |
| `getCollateralOraclePrice()` | Collateral price in UoA | Health factor, max borrow calculations |

**Locations using on-chain oracle prices:**
- Borrow page (`pages/borrow/`) - LTV slider, max borrow calculations
- Position pages (`pages/position/`) - Health factor, max withdraw constraints
- Account composable (`composables/useEulerAccount.ts`) - Account health calculation
- Vault overview components - Display oracle price (informational)

#### Off-Chain Preferred (Layer 2/3 - Async)

All display-only USD values use **`'off-chain'`** source:

| Function | Purpose | Call Count |
|----------|---------|------------|
| `getAssetUsdValue()` | USD value of asset amount | 60+ calls |
| `getCollateralUsdValue()` | USD value of collateral | 12+ calls |
| `getAssetUsdPrice()` | Asset price in USD | 4 calls |
| `getCollateralUsdPrice()` | Collateral price in USD | 5 calls |
| `formatAssetValue()` | Format + USD value | 20+ calls |
| `getUnitOfAccountUsdRate()` | UoA→USD rate | Used internally |

**Use cases for off-chain prices:**
- **Portfolio totals** - `totalSuppliedValue`, `totalBorrowedValue`, position values
- **Vault list pages** - TVL, available liquidity in USD
- **Vault detail pages** - Monthly earnings, deposit values
- **Position management** - Supply/borrow value displays (informational)
- **Transaction forms** - Live USD conversion below input fields
- **Vault cards/items** - TVL, liquidity, balance displays

#### Design Decision Summary

| Calculation Type | Source | Rationale |
|-----------------|--------|-----------|
| Health factor | On-chain | Must match protocol's liquidation logic |
| Max borrow/withdraw | On-chain | Safety-critical limits |
| LTV slider | On-chain | User expectations match protocol |
| USD displays | Off-chain | Better UX, backend can have more price feeds |
| Portfolio values | Off-chain | Display only, no safety impact |

## Architecture: 3-Layer System

```
┌─────────────────────────────────────────────────────────────┐
│                    Layer 3: USD Values                       │
│  getAssetUsdValue(), getCollateralUsdValue(), formatAssetValue() │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                   Layer 2: USD Prices                        │
│        getAssetUsdPrice(), getCollateralUsdPrice()           │
│                                                              │
│   Routes based on vault type:                                │
│   • Earn/Escrow/Securitize → assetPriceInfo (already USD)   │
│   • Regular EVK → oraclePrice × unitOfAccountRate           │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│              Layer 1: Raw Oracle Prices (UoA)               │
│    getAssetOraclePrice(), getCollateralOraclePrice()        │
│    getUnitOfAccountUsdRate()                                │
│                                                              │
│   Sources:                                                   │
│   • liabilityPriceInfo - vault's asset price in UoA         │
│   • collateralPrices[] - collateral prices in UoA           │
│   • unitOfAccountPriceInfo - UoA→USD conversion rate        │
└─────────────────────────────────────────────────────────────┘
```

## Price Data Sources in Vault Object

| Field | Source | Description |
|-------|--------|-------------|
| `liabilityPriceInfo` | VaultLens `getVaultInfoFull()` | Asset price in vault's unit of account |
| `collateralPrices[]` | VaultLens `getVaultInfoFull()` | Collateral prices from liability vault's perspective |
| `unitOfAccountPriceInfo` | UtilsLens `getAssetPriceInfo()` | UoA → USD conversion (fetched separately) |
| `assetPriceInfo` | UtilsLens `getAssetPriceInfo()` | Direct USD price (for Earn/Escrow/Securitize) |

## Key Functions

### Layer 1: Raw Oracle Prices

Located in `services/pricing/priceProvider.ts`:

- **`getAssetOraclePrice(vault)`** - Returns the vault's asset price in its unit of account from `liabilityPriceInfo` (always on-chain, synchronous)
- **`getCollateralOraclePrice(liabilityVault, collateralVault)`** - Returns collateral asset price in the liability vault's unit of account, converting from share price to asset price (always on-chain, synchronous)
- **`getUnitOfAccountUsdRate(vault)`** - Returns the UoA → USD conversion rate.
  - If `unitOfAccount === USD`, returns `1e18` (hardcoded)
  - Always tries backend first, falls back to on-chain (`vault.unitOfAccountPriceInfo`)
  - Since UoA is a common denominator, using off-chain rates doesn't affect health factor/LTV ratios - only USD display values. Callers don't need to specify a source.

**Internal Helpers:**
- `getCollateralShareOraclePrice(liabilityVault, collateralVault)` - Returns raw share price before asset conversion
- `getAssetUsdPriceFromOracle(vault, uoaRate)` - Oracle-based USD price calculation
- `getCollateralUsdPriceFromOracle(liabilityVault, collateralVault, uoaRate)` - Collateral oracle USD price

### Layer 2: USD Prices

- **`getAssetUsdPrice(vault)`** - Routes based on vault type:
  - Earn/Escrow/Securitize vaults: Returns `assetPriceInfo` directly (already in USD)
  - Regular EVK vaults: Returns `oraclePrice × uoaRate`

- **`getCollateralUsdPrice(liabilityVault, collateralVault)`** - Returns collateral price in USD using the liability vault's oracle and UoA rate

### Layer 3: USD Values

- **`getAssetUsdValue(amount, vault)`** - Calculates USD value of an asset amount. Returns `undefined` when no price is available.
- **`getCollateralUsdValue(amount, liabilityVault, collateralVault)`** - Calculates USD value of collateral in borrow context. Returns `undefined` when no price is available.
- **`getAssetUsdValueOrZero(amount, vault)`** - Convenience wrapper that returns `0` instead of `undefined`. Use in UI contexts where a missing price should display as zero.
- **`getCollateralUsdValueOrZero(amount, liabilityVault, collateralVault)`** - Same convenience wrapper for collateral values.
- **`formatAssetValue(amount, vault)`** - Formats value for UI display with price availability flag

## USD Price Calculation for Regular EVK Vault

```typescript
getAssetUsdPrice(vault, source, backend):
  1. If source='off-chain' and backend configured:
     - Try backend for direct asset USD price
     - If available, return backend price

  2. Oracle calculation (fallback or primary if source='on-chain'):
     a. oraclePrice = vault.liabilityPriceInfo.amountOutMid
        // On-chain. Scaled in vault.unitOfAccountDecimals (UoA's native decimals)
     b. uoaRate = await getUnitOfAccountUsdRate(vault)
        - Always tries backend first, falls back to on-chain
        - Returns 1e18 if vault.unitOfAccount === USD_ADDRESS
        - Always 18-decimal fixed-point (USD per 1 whole UoA token)
     c. return (oraclePrice × uoaRate) / 10^unitOfAccountDecimals
        // Result is 18-decimal USD. The divisor is the UoA's native decimals,
        // NOT 1e18 — for USD UoA those happen to coincide.
```

**Note on UoA Rate**: The UoA rate always tries the backend first, regardless of the caller's `source` parameter. Since UoA is a common denominator (both collateral and borrow prices use the same UoA), using an off-chain UoA rate doesn't affect health factor/LTV ratios - only the USD display values.

## Collateral Price Calculation (Borrow Context)

**Key principle: Collateral prices are ALWAYS from the liability vault's perspective.**

When vault A (liability) accepts vault B (collateral), the price of B is determined by vault A's oracle router, NOT vault B's own oracle. This ensures consistent pricing within a borrow position.

```typescript
getCollateralUsdPrice(liabilityVault, collateralVault, source, backend):
  1. If source='off-chain' and backend configured:
     - Try backend for direct collateral USD price
     - If available, return backend price

  2. Oracle calculation (fallback or primary if source='on-chain'):
     a. sharePrice = liabilityVault.collateralPrices.find(collateralVault.address)
     b. assetPrice = sharePrice × (totalShares / totalAssets)  // Convert share→asset
        // Special case: if totalAssets=0 AND totalShares=0 (empty vault),
        // ERC-4626 standard defines 1:1 ratio, so use sharePrice directly
     c. uoaRate = await getUnitOfAccountUsdRate(liabilityVault)
        // Use LIABILITY's UoA - always tries backend first
     d. return (assetPrice × uoaRate) / 10^liabilityVault.unitOfAccountDecimals
        // Same scaling rule as getAssetUsdPrice — divisor is UoA's native decimals.
```

## EulerRouter Oracle Configuration

Most EVK vaults use an EulerRouter as their oracle. The router's `oracleDetailedInfo` contains the complete configuration for ALL pricing pairs the vault needs:

```typescript
type EulerRouterInfo = {
  governor: Address
  fallbackOracle: Address
  fallbackOracleInfo: OracleDetailedInfo
  bases: Address[]                    // All base assets (liability + all collaterals)
  quotes: Address[]                   // All quote assets (typically unit of account)
  resolvedAssets: Address[][]
  resolvedOracles: Address[]
  resolvedOraclesInfo: OracleDetailedInfo[]  // Oracle config for EACH (base, quote) pair
}
```

This means when we decode a vault's `oracleDetailedInfo`:
- `bases[]` contains the liability asset AND all accepted collateral assets
- `resolvedOraclesInfo[]` contains the oracle configuration for each pricing pair
- The full oracle tree (including nested Pyth oracles) is available for traversal

## Pyth Oracle Handling

> For a general overview of Pyth and how price updates work in real transactions (write path), see [Pyth Oracle Handling](./pyth-oracle-handling.md). This section covers the read/simulation side in detail.

### The Problem

Unlike Chainlink oracles that maintain on-chain prices, Pyth oracles require explicit price updates via `updatePriceFeeds()` before they can be queried. When the on-chain Pyth price is stale (past `maxStaleness`), the VaultLens query returns `queryFailure: true` and no valid price.

### The Solution

Since Pyth prices are only valid for ~2 minutes after on-chain update, the system **always refreshes** when Pyth oracles are detected (not just on price failure). This is implemented using EVC `batchSimulation` to simulate Pyth price updates alongside lens calls:

1. **Detection**: `collectPythFeedIds()` extracts ALL Pyth feed IDs from `vault.oracleDetailedInfo`
2. **Simulation**: `executeLensWithPythSimulation()` bundles Pyth updates with any lens call (vault or account)
3. **Always Refresh**: When Pyth is detected, always fetch fresh data rather than using cached values

### Why This Works for Collaterals Too

The `collectPythFeedIds()` function recursively traverses the entire oracle configuration:

```typescript
if (info.name === 'EulerRouter') {
  const decoded = decodeEulerRouterInfo(info.oracleInfo)
  visit(decoded.fallbackOracleInfo, depth + 1)
  decoded.resolvedOraclesInfo?.forEach(child => visit(child, depth + 1))  // ALL pairs!
}
```

Since `resolvedOraclesInfo` contains oracle configs for ALL (base, quote) pairs in the router (including collateral pricing), ALL Pyth feeds get collected - not just the liability asset's feed. This ensures that when we refresh a vault via Pyth simulation:

1. Pyth feeds for the liability asset are refreshed → `liabilityPriceInfo` is fresh
2. Pyth feeds for collateral pricing are ALSO refreshed → `collateralPrices[]` is fresh

### Pyth Handling Flow

**Bulk Vault Loading (vault list pages):**
```
fetchVaults() generator called
                ↓
    Fetch batch of vaults in parallel
    (getVaultInfoFull for each - fast path)
                ↓
    For each vault in batch:
    collectPythFeedIds() checks
    vault.oracleDetailedInfo
                ↓
        ┌───────┴───────┐
        │ Pyth detected? │
        └───────┬───────┘
           No   │   → Keep vault as-is
                ↓ Yes
    Collect all Pyth vaults, then batch re-fetch
    via executeBatchLensWithPythSimulation():
    1. Merge + deduplicate all feeds across vaults
    2. Build Pyth updates + all lens calls
    3. Execute single EVC batchSimulation
                ↓
    Replace original vaults with refreshed versions
                ↓
    Yield batch (with fresh Pyth prices)
```

**Single Vault Fetching (pages like /lend, /borrow):**
```
fetchVault(vaultAddress) called
                ↓
        Standard query first
    (getVaultInfoFull - fast path)
                ↓
    collectPythFeedIds() checks
    vault.oracleDetailedInfo
                ↓
        ┌───────┴───────┐
        │ Pyth detected? │
        └───────┬───────┘
           No   │   → Return vault as-is
                ↓ Yes
    ALWAYS re-query with simulation
    (Pyth prices only valid ~2 min)
                ↓
    fetchVaultWithPythSimulation():
    1. Fetch fresh prices via /api/pyth/updates server proxy
    2. Build Pyth updatePriceFeeds() batch items
    3. Build getVaultInfoFull() batch item
    4. Execute EVC batchSimulation
    5. Return fresh vault data
```

**Portfolio/Account Loading (useEulerAccount.ts):**
```
updateBorrowPositions() called
                ↓
    For each borrow position:
    Pre-fetch vault via getOrFetch()
                ↓
    collectPythFeedIds() checks
    vault.oracleDetailedInfo
                ↓
        ┌───────┴───────┐
        │ Pyth detected? │
        └───────┬───────┘
           Yes  │  No → Direct accountLens.getVaultAccountInfo()
                ↓
    executeLensWithPythSimulation():
    1. Build Pyth update batch items
    2. Build getVaultAccountInfo() batch item
    3. Execute EVC batchSimulation
    4. Get fresh account data with updated prices
                ↓
    hasPythOracles(borrow) check
                ↓
           Yes  │  No → Use cached vault
                ↓
    fetchVault() for FRESH borrow vault
    (Refreshes BOTH liabilityPriceInfo AND
     collateralPrices[] - see "Why This Works
     for Collaterals Too" section above)
```

Note: We only refresh the BORROW vault, not the collateral vault. Collateral prices come from `borrow.collateralPrices[]`, which are refreshed when we fetch the borrow vault. The collateral vault only provides `totalAssets`/`totalShares` for share→asset conversion, which aren't affected by Pyth.

### Key Implementation Details

**Reusable Pyth Simulation Helper (`utils/pyth.ts`):**
```typescript
// Generic helper for ANY lens call with Pyth simulation
export const executeLensWithPythSimulation = async <T>(
  feeds: PythFeed[],
  lensContract: ethers.Contract,
  lensMethod: string,
  lensArgs: unknown[],
  evcAddress: string,
  provider: ethers.JsonRpcProvider,
  providerUrl: string,
  hermesEndpoint: string,
): Promise<T | undefined> => {
  // 1. Build Pyth update batch items
  const { items: pythItems, totalFee } = await buildPythBatchItemsFromFeeds(...)

  // 2. Build lens batch item
  const lensBatchItem = { targetContract, data: encodedCall, ... }

  // 3. Execute batch simulation
  const [batchResults] = await evcContract.batchSimulation.staticCall(
    [...pythItems, lensBatchItem],
    { value: totalFee },
  )

  // 4. Return decoded lens result
  return lensContract.interface.decodeFunctionResult(lensMethod, lensResult.result)
}
```

### Additional Pyth Utilities

Located in `utils/pyth.ts`:

**Feed Collection:**
- `collectPythFeedIds(oracleInfo, maxDepth?)` - Extract feeds from single oracle config
- `collectPythFeedsFromVaults(vaults, maxDepth?)` - Collect from multiple vaults, deduplicated

**Price/Update Fetching:**
- `fetchPythUpdateData(feedIds, endpoint)` - Fetch update data via `/api/pyth/updates` proxy (100ms batching, 15s cache)
- `fetchPythPrices(feedIds, endpoint, cacheTtlMs?)` - Fetch actual price values

**Batch Building:**
- `buildPythUpdateCalls(vaults, providerUrl, hermesEndpoint, sender)` - Build EVCCall[] format
- `buildPythBatchItems(vaults, providerUrl, hermesEndpoint)` - Build BatchItem[] format
- `buildPythBatchItemsFromFeeds(feeds, providerUrl, hermesEndpoint)` - Pre-collected feeds version

**Utilities:**
- `sumCallValues(calls)` - Sum fees from multiple calls

**fetchVault() in `entities/vault/fetcher.ts`:**
```typescript
// 1. Standard query first (fast path)
const raw = await vaultLensContract.getVaultInfoFull(vaultAddress)
let vault = processRawVaultData(raw, ...)

// 2. Check if Pyth AND has price failure
// Note: 0n is a valid price (very small value), so we don't treat it as failure
const feeds = collectPythFeedIds(vault.oracleDetailedInfo)
const hasPythPriceFailure = feeds.length > 0 && (
  vault.liabilityPriceInfo?.queryFailure ||
  vault.liabilityPriceInfo?.amountOutMid === undefined ||
  vault.liabilityPriceInfo?.amountOutMid === null
)

// 3. Re-query with simulation if failure detected
if (hasPythPriceFailure && evc && PYTH_HERMES_URL) {
  vault = await fetchVaultWithPythSimulation(...) || vault
}
```

**Portfolio Loading (`composables/useEulerAccount.ts`):**
```typescript
// Helper to detect Pyth oracles
const hasPythOracles = (vault: Vault): boolean => {
  const feeds = collectPythFeedIds(vault.oracleDetailedInfo)
  return feeds.length > 0
}

// In updateBorrowPositions():
// 1. Use Pyth simulation for account lens if Pyth detected
if (canUsePythSimulation) {
  const result = await executeLensWithPythSimulation(
    pythFeeds, accountLensContract, 'getVaultAccountInfo', ...
  )
  res = result[0]
}

// 2. ALWAYS fetch fresh borrow vault when Pyth detected (valid only ~2 min)
// This refreshes BOTH liabilityPriceInfo AND collateralPrices[]
if (hasPythOracles(borrow)) {
  const freshBorrow = await fetchVault(borrowAddress)
  if (freshBorrow) borrow = freshBorrow
}

// Note: No need to refresh collateral vault - collateral prices come from
// borrow.collateralPrices[], already refreshed above
```

### EVC batchSimulation Usage

```typescript
// Build batch items
const batchItems = [
  ...pythUpdateBatchItems,  // Pyth price updates
  vaultLensBatchItem,       // getVaultInfoFull() call
]

// Execute simulation
const [batchResults] = await evcContract.batchSimulation.staticCall(
  batchItems,
  { value: totalPythFee },
)

// Last result contains vault data
const vaultLensResult = batchResults[batchResults.length - 1]
const decoded = vaultLensContract.interface.decodeFunctionResult(
  'getVaultInfoFull',
  vaultLensResult.result,
)
```

## Vault Type Routing

The pricing system handles different vault types:

| Vault Type | Price Source | Notes |
|------------|--------------|-------|
| Regular EVK | `liabilityPriceInfo` + UoA conversion | Standard oracle-based pricing |
| Earn | `assetPriceInfo` | UtilsLens provides USD price directly |
| Escrow | `assetPriceInfo` | UtilsLens provides USD price directly |
| Securitize | `assetPriceInfo` | UtilsLens provides USD price directly |

Detection logic in `priceProvider.ts`:
```typescript
const usesUtilsLensPricing = (vault): boolean => {
  return isEarnVault(vault) || isEscrowVault(vault) || isSecuritizeVault(vault)
}
```

## Design Principles

1. **Collateral prices from liability vault's perspective** - Collateral is always priced using the liability vault's oracle router, ensuring consistent pricing within a borrow position
2. **No hardcoded fallbacks** - If a price cannot be determined, return `undefined` rather than assuming values
3. **Pyth handled via simulation** - Fresh prices are obtained through EVC batch simulation, not fallbacks. Both single vault fetching (`fetchVault`) and bulk loading (`fetchVaults`) handle Pyth simulation
4. **Complete oracle traversal** - When refreshing Pyth prices, ALL feeds in the oracle configuration are updated (liability AND collaterals)
5. **Layered architecture** - Clear separation between raw oracle data, USD conversion, and value calculation
6. **Vault type awareness** - Different vault types route to appropriate price sources
7. **Empty vault handling** - ERC-4626 empty vaults (totalAssets=0, totalShares=0) use 1:1 share-to-asset ratio per standard
8. **Zero is valid** - A price of 0n is valid (very small value due to precision), only `undefined`/`null` or `queryFailure` indicate missing prices

## Intrinsic APY

The `useIntrinsicApy` composable adds yield intrinsic to the underlying asset (e.g., stETH staking yield, sDAI DSR, Pendle PT implied yield) on top of vault supply/borrow APY. This is separate from the oracle-based pricing system but affects displayed APY values.

- **Data sources**: DefiLlama yields API (LSTs, yield-bearing stablecoins) and Pendle V2 API (PT implied yield)
- **Configuration**: Token-to-provider mappings in `entities/custom.ts` (`intrinsicApySources`)
- **Lookup**: By token address (not symbol)
- **Caching**: 5-minute TTL with chain-switch invalidation
- **Compounding formula**: `effectiveAPY = baseAPY + (1 + baseAPY / 100) * intrinsicAPY`

See [Intrinsic APY](./intrinsic-apy.md) for the full architecture and provider details.

## Files

- `services/pricing/priceProvider.ts` - Core pricing functions (Layers 1-3)
- `entities/vault/` - Vault data models (split into focused modules)
  - `entities/vault/fetcher.ts` - Vault fetching with Pyth simulation support
  - `entities/vault/pricing.ts` - Vault pricing helpers
  - `entities/vault/types.ts` - Vault type definitions
  - `entities/vault/utils.ts` - Type guards (`isEarnVault`, `isEscrowVault`, etc.)
- `entities/oracle.ts` - Oracle decoding and Pyth feed collection (EulerRouter, CrossAdapter, PythOracle)
- `composables/useEulerAccount.ts` - Portfolio/account loading with Pyth simulation for borrow positions
- `composables/useIntrinsicApy.ts` - Intrinsic APY orchestrator (multi-provider, address-based lookup)
- `services/intrinsicApy/defillamaProvider.ts` - DefiLlama intrinsic APY provider
- `services/intrinsicApy/pendleProvider.ts` - Pendle PT implied yield provider
- `pages/borrow/[collateral]/[borrow]/index.vue` - Borrow page Pyth refresh logic
- `pages/lend/[vault]/index.vue` - Lend page Pyth refresh logic
- `utils/pyth.ts` - Pyth-specific utilities (server proxy calls, batch building, `executeLensWithPythSimulation()`)
