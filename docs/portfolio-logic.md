# Portfolio Logic

This document explains how euler-lite discovers, categorizes, and prices a user's portfolio positions. The main composable is `useEulerAccount` (`composables/useEulerAccount.ts`), which orchestrates position loading and exposes reactive state consumed by the UI.

## Position Categories

Every on-chain deposit a user holds falls into one of three categories:

| Category | Description | Data Source |
|----------|-------------|-------------|
| **Borrow Position** | A deposit used as collateral backing a loan | Subgraph `borrows` + AccountLens |
| **Savings (Deposit/Earn)** | A standalone deposit not used as collateral (includes both EVK and EulerEarn vaults) | Subgraph `deposits` + AccountLens |

Savings positions are stored in a single `depositPositions` array. The UI splits them into "Managed lending" (earn vaults) and "Direct lending" (EVK/securitize vaults) using `isEarnVault()` from the vault registry.

Portfolio cards can display operational **portfolio notices** from the labels system (e.g. migration announcements, temporary pauses). Notices are resolved via `getVaultNotice()` which checks earn vault notices, vault overrides, and product-level `portfolioNotice` in priority order. On borrow cards, collateral and borrow notices are shown separately with deduplication when both vaults share the same product-level notice.

### How Categorization Works

Categorization depends on a strict loading order: **borrows first, then savings**.

#### Step 1: Load Borrow Positions

`updateBorrowPositions()` queries the subgraph for all borrow entries associated with the user's address prefix:

```graphql
query AccountBorrows {
  trackingActiveAccount(id: "<addressPrefix>") {
    borrows
  }
}
```

Each entry is a concatenation of `subAccount + vaultAddress` (42 + 42 hex chars). For each borrow entry:

```
borrow entry (from subgraph)
  |
  |-- Does accountLens.getVaultAccountInfo succeed?
  |     NO  -> skip
  |
  |-- Is isController false or borrowed === 0?
  |     YES -> skip (no active borrow)
  |
  |-- Resolve borrow vault via getOrFetch(enabledControllers[0])
  |     NOT FOUND -> skip
  |
  |-- Resolve primary collateral from enabled collaterals
  |     (prefer collaterals with configured LTV on borrow vault)
  |     NOT FOUND -> skip
  |
  |-- Are both borrow and collateral vaults unverified and !showAllPositions?
  |     YES -> skip
  |
  |-- Are collateral or borrow prices missing?
  |     YES -> skip
  |
  +-- Include as borrow position
```

After processing all entries, a `collateralUsageSet` is built containing every `"subAccount:collateralVaultAddress"` pair. This is the key data structure that enables the savings/position split — deposits that appear in this set are shown under their borrow position rather than as standalone savings.

#### Step 2: Load Savings Positions

`updateSavingsPositions()` makes a **single** subgraph query for deposits and processes all vault types (EVK, securitize, and earn) in one pass:

```graphql
query AccountDeposits {
  trackingActiveAccount(id: "<addressPrefix>") {
    deposits
  }
}
```

Entries are processed in batches of 5 for performance. For each deposit entry:

```
deposit entry
  |
  |-- Is (subAccount:vaultAddress) in collateralUsageSet?
  |     YES -> skip (this deposit is collateral, shown under borrow position)
  |
  |-- Resolve vault via getOrFetch (handles all vault types uniformly)
  |     NOT FOUND -> skip
  |
  |-- Is vault unverified and !showAllPositions?
  |     YES -> skip
  |
  |-- Does accountLens return shares > 0?
  |     NO  -> skip
  |
  +-- Include as savings position (in depositPositions array)
```

The UI then filters the unified `depositPositions` array:
- **Managed lending (earn)**: `depositPositions.filter(p => isEarnVault(p.vault.address))`
- **Direct lending (EVK/securitize)**: `depositPositions.filter(p => !isEarnVault(p.vault.address))`

### Position Types

```typescript
interface AccountBorrowPosition {
  borrow: Vault               // The liability (borrow) vault
  collateral: Vault            // The primary collateral vault
  collaterals: string[]        // All collateral addresses with value
  subAccount: string           // EVC sub-account address
  health: bigint               // Health factor (1e18 scale)
  userLTV: bigint              // Current loan-to-value ratio
  borrowed: bigint             // Liability amount in borrow asset
  supplied: bigint             // Collateral amount in collateral asset
  price: bigint                // Liquidation price in USD
  borrowLTV: bigint            // Maximum borrow LTV
  liquidationLTV: bigint       // Liquidation threshold LTV
  liabilityValue: bigint       // Liability value in UoA
  collateralValueLiquidation: bigint // Collateral value at liquidation LTV
  timeToLiquidation: bigint    // Seconds until liquidation (MAX_UINT = safe)
}

interface AccountDepositPosition {
  vault: Vault | SecuritizeVault | EarnVault  // Any savings vault type
  subAccount: string           // EVC sub-account address
  shares: bigint               // Vault share balance
  assets: bigint               // Equivalent asset amount
}
```

All vault types now have `interestRateInfo: VaultInterestRateInfo` with a unified `supplyAPY` field (bigint, 25-decimal precision). For earn vaults, `borrowAPY`/`borrowSPY`/`borrows` are `0n` and `cash` equals `totalAssets`.

## Lens Contract Usage

Lens contracts are read-only helpers deployed on every Euler chain. They aggregate multiple on-chain reads into a single call, reducing RPC round-trips.

### Lens Contracts

| Contract | Purpose | Key Method |
|----------|---------|------------|
| **VaultLens** | Full vault info (prices, LTVs, rates, oracle config) | `getVaultInfoFull(vault)` |
| **AccountLens** | Per-account position data (balances, health, liquidity) | `getVaultAccountInfo(account, vault)` |
| **UtilsLens** | Utility pricing (asset USD price, ERC-4626 info, APY) | `getAssetPriceInfo(asset, quoteAsset)` |
| **EulerEarnVaultLens** | EulerEarn-specific vault info (strategies, governance) | `getVaultInfoFull(vault)` |
| **OracleLens** | Oracle configuration details | Used indirectly via VaultLens |
| **IRMLens** | Interest rate model parameters | Used indirectly via VaultLens |

### VaultLens: `getVaultInfoFull`

Returns the complete state of an EVK vault in a single call:

- **Basic info**: name, symbol, decimals, totalAssets, totalShares, supply/borrow caps
- **`liabilityPriceInfo`**: The vault asset's price in the vault's unit of account (UoA). Contains `amountOutMid`, `amountOutAsk`, `amountOutBid` (18-decimal fixed-point).
- **`collateralPrices[]`**: Price of each accepted collateral in the vault's UoA. These are **share prices** (price per vault share, not per underlying asset).
- **`collateralLTVs[]`**: Borrow LTV, liquidation LTV, and ramp parameters for each collateral.
- **`oracleDetailedInfo`**: Recursive oracle configuration tree (see Oracle section below).
- **`interestRateInfo`**: Current borrow/supply APY, cash, borrows.

### AccountLens: `getVaultAccountInfo`

Returns per-account data for a specific sub-account and vault directly as a flat `VaultAccountInfo` struct:

- **`isController`** / **`isCollateral`**: Whether the vault is an active controller/collateral for this account.
- **`shares`**, **`assets`**, **`borrowed`**: Position balances.
- **`liquidityInfo`**: Health and collateral breakdown:
  - `collateralValueLiquidation` / `liabilityValueBorrowing`: Used to compute health factor.
  - `timeToLiquidation`: Estimated seconds until health drops below 1.0.
  - `collaterals[]` / `collateralValuesRaw[]`: Per-collateral breakdown.

### UtilsLens: `getAssetPriceInfo`

Provides a direct USD price for any asset by querying on-chain oracle infrastructure:

```typescript
utilsLens.getAssetPriceInfo(assetAddress, USD_ADDRESS)
// Returns: { amountOutMid: bigint }  (18-decimal USD price)
```

Used for two purposes:
1. **`assetPriceInfo`** on earn/escrow/securitize vaults (direct USD pricing, bypassing oracle router).
2. **`unitOfAccountPriceInfo`** on regular EVK vaults (converting UoA to USD).

### Batch Optimization

Multiple lens calls are batched into a single RPC request using `EVC.batchSimulation()` (`utils/multicall.ts`). This is preferred over Multicall3 because the EVC contract is guaranteed to exist on all Euler chains.

```
batchLensCalls(evcAddress, lensAddress, lensInterface, calls, provider)
  1. Encode each call as a BatchItem { targetContract, data, value }
  2. Execute EVC.batchSimulation(items) as a staticCall
  3. Decode each result using the lens ABI
```

During vault loading (`fetchVaults`), vaults are batched in groups of ~25 per RPC call.

## Pricing Architecture

The pricing system (`services/pricing/priceProvider.ts`) is a 3-layer architecture. For full details see [pricing-system.md](./pricing-system.md).

### Layer 1: Raw Oracle Prices (Unit of Account)

Always on-chain. No backend fallback.

| Function | Input | Output |
|----------|-------|--------|
| `getAssetOraclePrice(vault)` | EVK vault | Asset price in vault's UoA |
| `getCollateralOraclePrice(liabilityVault, collateralVault)` | Borrow + collateral vault | Collateral asset price in borrow vault's UoA |

**Collateral pricing** always uses the borrow (liability) vault's oracle, not the collateral vault's oracle. The borrow vault stores `collateralPrices[]` which are share prices. These are converted to asset prices:

```
assetPrice = sharePrice * (totalShares / totalAssets)
```

For empty vaults (both zero), the ERC-4626 standard defines a 1:1 ratio.

### Layer 2: USD Prices

Adds USD conversion. Supports `'on-chain'` and `'off-chain'` price sources.

| Function | Notes |
|----------|-------|
| `getAssetUsdPrice(vault, source)` | Off-chain tries backend first |
| `getCollateralUsdPrice(liabilityVault, collateralVault, source)` | Always uses liability vault's oracle |

**Vault type routing** determines how the USD price is calculated:

```
Is vault earn/escrow/securitize?
  YES -> Use assetPriceInfo (UtilsLens, already in USD)
  NO  -> oraclePrice (Layer 1) * unitOfAccountUsdRate
```

The UoA-to-USD rate is fetched once per vault during loading and cached on the vault object as `unitOfAccountPriceInfo`. For vaults where the UoA is already USD (common case), the rate is 1.0.

### Layer 3: USD Values

Combines a token amount with a USD price:

```typescript
getAssetUsdValue(amount, vault, source)      // amount * assetUsdPrice
getCollateralUsdValue(amount, liabilityVault, collateralVault, source)
```

### Backend Price Client

The backend (`services/pricing/backendClient.ts`) provides off-chain prices from the Euler indexer:

- **Endpoint**: `GET /v3/prices?chainId={id}&addresses={addr1,addr2,...}`
- **Response**: `{ data: [{ chainId, address, symbol, priceUsd, source, timestamp }], meta }`
- **Batching**: Requests within a 100ms window are combined into a single HTTP call
- **Cache**: 60-second TTL per asset per chain

The backend is a **soft fallback** - on-chain pricing is always available. The backend is preferred for display-only values (portfolio totals) because it avoids the latency of multiple RPC calls.

### Total Portfolio Value Calculation

```
totalSuppliedValue = sum of:
  - deposit positions (all types): getAssetUsdValue(assets, vault, 'off-chain')
  - borrow collateral: getCollateralUsdValue(supplied, borrowVault, collateralVault, 'off-chain')

totalBorrowedValue = sum of:
  - borrow positions:  getAssetUsdValue(borrowed, borrowVault, 'off-chain')
```

Both are computed reactively and update when position data changes.

## Pyth Oracle Handling

Pyth oracles are pull-based: prices must be explicitly pushed on-chain before they can be read. This fundamentally differs from push-based oracles (Chainlink) where prices are updated independently. Because Pyth prices expire after ~2 minutes, the app must update them before every read.

### Detection: Recursive Oracle Traversal

`collectPythFeedIds()` (`entities/oracle.ts`) recursively walks the oracle configuration tree returned by VaultLens:

```
oracleDetailedInfo
  |
  |-- name === "EulerRouter"
  |     Decode -> traverse fallbackOracleInfo + resolvedOraclesInfo[]
  |
  |-- name === "CrossAdapter"
  |     Decode -> traverse oracleBaseCrossInfo + oracleCrossQuoteInfo
  |
  |-- name === "PythOracle"
  |     Decode -> extract { pythAddress, feedId }
  |
  +-- Other adapters (Chainlink, etc.) -> ignored
```

The traversal is depth-limited (default 3) and deduplicates feeds by `pythAddress:feedId`.

### Fresh Price Injection via `batchSimulation`

The core mechanism for getting fresh Pyth prices is `executeLensWithPythSimulation()` (`utils/pyth.ts`):

```
1. Collect all Pyth feed IDs from the vault's oracle tree
2. Fetch latest price data from Pyth Hermes API (/v2/updates/price/latest)
3. Build batch items:
     [pythContract.updatePriceFeeds(data), ...,  lensContract.getVaultInfoFull(vault)]
4. Execute EVC.batchSimulation(items) as a staticCall
5. Pyth prices are updated in the simulation context
6. Lens call reads fresh prices
7. Decode and return the lens result
```

This is a `staticCall` - no transaction is sent, no gas is spent, and the state changes are discarded after the call. The simulation simply ensures the lens reads up-to-date Pyth prices.

### Pyth Update Data Fetching

`fetchPythUpdateData()` fetches price update payloads from the Pyth Hermes API with two optimizations:

- **Request batching**: Multiple calls within a 100ms window are grouped by endpoint, with all unique feed IDs combined into a single HTTP request.
- **Caching**: Results are cached for 15 seconds to avoid redundant network requests when multiple vaults share the same Pyth feeds.

### Where Pyth Simulation Is Used

**Bulk vault fetching** (`entities/vault/fetcher.ts: fetchVaults`):
1. Batch-fetch vaults via `batchLensCalls()` (fast path).
2. Collect all Pyth-enabled vaults via `collectPythFeedIds()`.
3. Batch re-fetch all Pyth vaults in a single `batchSimulation` via `executeBatchLensWithPythSimulation()`.
4. Replace vault data with simulation results (contains fresh prices in `liabilityPriceInfo` and `collateralPrices[]`).

**Single vault fetching** (`entities/vault/fetcher.ts: fetchVault`):
1. Call `vaultLens.getVaultInfoFull()` normally (fast path).
2. If Pyth detected: re-query with `fetchVaultWithPythSimulation()` → `executeLensWithPythSimulation()`.
3. Replace vault data with simulation result.

**Borrow position loading** (`composables/useEulerAccount.ts: updateBorrowPositions`):
1. Pre-fetch the borrow vault to check for Pyth oracles.
2. If Pyth detected: call `executeLensWithPythSimulation()` with `accountLens.getVaultAccountInfo()` to get liquidity info with fresh prices.
3. Additionally, re-fetch the borrow vault itself (`fetchVault`) to get fresh collateral prices for display.

**Transaction building** (`utils/pyth.ts: buildPythUpdateCalls`):
When submitting transactions that interact with Pyth-priced vaults, Pyth update calls are prepended to the EVC batch so prices are fresh when the vault reads them.

### Design Decisions

1. **Always re-fetch with Pyth**: Even if the initial lens call succeeds, the prices may be stale. The system always re-queries with simulation when Pyth is detected.
2. **Complete oracle traversal**: All Pyth feeds in the tree are updated (liability + all collaterals), not just the specific pair being queried. This ensures consistent pricing.
3. **Simulation, not transactions**: Using `batchSimulation` (staticCall) means no gas cost for price reads. Actual Pyth updates only happen when submitting real transactions.

## Data Flow Summary

```
                    Subgraph
                       |
                       | (address discovery)
                       v
              +------------------+
              | useEulerAccount  |
              +------------------+
              |                  |
    borrows[] |                  | deposits[]
              v                  v
   +-------------------+  +------------------------+
   | updateBorrowPos() |  | updateSavingsPos()     |
   +-------------------+  | (single query, all     |
              |           |  vault types, batched)  |
              |  AccountLens  +------------------------+
              |  (+ Pyth sim)        |
              v                      v
   +-------------------+  +------------------------+
   | BorrowPosition[]  |  | DepositPosition[]      |
   +-------------------+  | (EVK + Earn + Securitize)|
              |           +------------------------+
              | collateralUsage      |
              | Set (filters         |
              | deposits)            |
              v                      v
          +-----------------------------+
          | priceProvider (3-layer)     |
          |  Layer 1: Oracle (UoA)      |
          |  Layer 2: USD conversion    |
          |  Layer 3: USD values        |
          +-----------------------------+
              |
              v
          Portfolio Totals
          (totalSupplied, totalBorrowed)
```

## Performance Optimizations

### Batch Pyth Vault Refresh

When loading borrow positions with Pyth-priced vaults, the system batch-fetches all Pyth vaults in a single `executeBatchLensWithPythSimulation()` call using `getVaultInfoFull` instead of calling `fetchVault()` individually for each. This eliminates ~15 sequential HTTP requests during portfolio load. The implementation collects all Pyth-enabled borrow vaults, deduplicates their feeds, and executes one batch simulation.

### Concurrent Wallet Balance Fetching

Token balance fetching in `useWallets.ts` uses `Promise.all()` for concurrent requests instead of a sequential `for...await` loop. This allows viem's HTTP transport to batch multiple `readContract` calls into fewer RPC requests, eliminating ~25 sequential HTTP requests and significantly reducing load time.

### Polling Order

The poll interval awaits `updateBalances()` before `refreshVaults()` to ensure wallet balances are fresh when vault data triggers position recalculation.

## Related Documentation

- [Pricing System](./pricing-system.md) — Full pricing architecture details
- [Pyth Oracle Handling](./pyth-oracle-handling.md) — How Pyth oracles affect position loading
- [Vault Labels & Verification](./vault-labels-and-verification.md) — How vault verification affects position visibility

### Reactive Update Triggers

The portfolio refreshes when:
- Wallet balances finish loading (`isBalancesLoaded`)
- Lens addresses become available (`isEulerLensAddressesReady`)
- The "show all positions" toggle changes
- The wallet address changes (account switch or debug address)
