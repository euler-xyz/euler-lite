# Portfolio Logic

This document explains how euler-lite discovers, categorizes, and prices a user's portfolio positions. The main composable is `useEulerAccount` (`composables/useEulerAccount.ts`), which orchestrates position loading and exposes reactive state consumed by the UI.

## Position Categories

Every on-chain deposit a user holds falls into one of three categories:

| Category | Description | Data Source |
|----------|-------------|-------------|
| **Borrow Position** | A deposit used as collateral backing a loan | Subgraph `borrows` + AccountLens |
| **Savings (Deposit/Earn)** | A standalone deposit not used as collateral (includes both EVK and EulerEarn vaults) | Subgraph `deposits` + AccountLens |

Savings positions are stored in a single `depositPositions` array. The UI splits them into "Curated lending" (earn vaults) and "Direct lending" (EVK/securitize vaults) using `isEarnVault()` from the vault registry.

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

The SDK portfolio model handles the savings/borrow split directly: deposits used as collateral are represented through borrow positions, while standalone deposits are returned in `portfolio.savings`.

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
- **Curated lending (earn)**: `depositPositions.filter(p => isEarnVault(p.vault.address))`
- **Direct lending (EVK/securitize)**: `depositPositions.filter(p => !isEarnVault(p.vault.address))`

### Position Types

```typescript
interface PortfolioBorrowPosition {
  borrow: AccountPosition      // The liability (borrow) position
  collaterals: AccountPosition[] // Collateral positions backing the debt
  collateral?: AccountPosition // The primary collateral position
  borrowVault?: Vault          // Populated liability vault
  collateralVault?: Vault      // Populated primary collateral vault
  collateralVaults: string[]   // All collateral addresses with value
  subAccount: string           // EVC sub-account address
  healthFactor?: bigint        // Health factor (1e18 scale)
  userLTV?: bigint             // Current loan-to-value ratio
  borrowed: bigint             // Liability amount in borrow asset
  supplied: bigint             // Collateral amount in collateral asset
  primaryCollateralLiquidationPrice: bigint // Primary collateral liquidation price in USD
  liquidatable: boolean        // Liability liquidation value exceeds collateral
  borrowLTV?: number           // Maximum borrow LTV
  liquidationLTV?: number      // Pair liquidation threshold LTV
  accountLiquidationLTV?: number // Account liquidation threshold LTV
  timeToLiquidation?: DaysToLiquidation
}

interface PortfolioSavingsPosition {
  position: AccountPosition
  vault?: Vault | SecuritizeVault | EarnVault // Any savings vault type
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

Returns the complete state of an EVault in a single call:

- **Basic info**: name, symbol, decimals, totalAssets, totalShares, supply/borrow caps
- **`liabilityPriceInfo`**: The vault asset's price in the vault's unit of account (UoA). Contains `amountOutMid`, `amountOutAsk`, `amountOutBid` scaled in the **UoA token's native decimals** (`unitOfAccountDecimals`) — not always 18. The USD-magic UoA address (`0x…0348`) is treated as 18 decimals on-chain, which is why USD-denominated vaults look like 18-decimal fixed-point. Conversion to USD must divide by `10^unitOfAccountDecimals`, not by `1e18`.
- **`collateralPrices[]`**: Price of each accepted collateral in the vault's UoA, same scaling rules as `liabilityPriceInfo`. These are **share prices** (price per vault share, not per underlying asset).
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
2. **`unitOfAccountPriceInfo`** on regular EVaults (converting UoA to USD).

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

Pricing is SDK-backed. Lite keeps compatibility helpers in `utils/sdk-prices.ts`. For full details see [pricing-system.md](./pricing-system.md).

Raw oracle calculations use SDK helpers such as `getAssetOraclePrice()` and `getCollateralOraclePrice()`. Display USD values use SDK precomputed market fields:

| UI value | SDK-backed source |
|----------|-------------------|
| Vault asset USD price | `vault.marketPriceUsd` |
| Borrow-context collateral USD price | `borrowVault.collaterals[].marketPriceUsd` |
| Borrowed position value | `position.borrow.borrowedValueUsd` |
| Total borrow-position collateral value | `position.totalCollateralValueUsd` |
| Per-collateral borrow-position value | `position.borrow.liquidity.collaterals[].valueUsd` |
| Borrow-position Net APY | `position.netApy` |
| Borrow-position ROE | `position.roe` |

Portfolio borrow cards use the SDK portfolio position fields directly for collateral value, debt value, NAV, Net APY, and ROE.

### Total Portfolio Value Calculation

```
totalSuppliedValue = sum of:
  - SDK totalSuppliedValueUsd

totalBorrowedValue = sum of:
  - SDK totalBorrowedValueUsd
```

Both are computed reactively and update when position data changes.

## Pyth Oracle Handling

Pyth oracles are pull-based: prices must be explicitly pushed on-chain before they can be read. This fundamentally differs from push-based oracles (Chainlink) where prices are updated independently. Because Pyth prices expire after ~2 minutes, the app must update them before every read.

### Detection: Selected Oracle Routes

SDK EVault entities expose selected oracle routes instead of the full recursive
oracle tree. Lite collects Pyth feeds from `debtPricingOracleRoute.steps` and
from each enabled collateral's `oracleRoute.steps`.

The collection deduplicates feeds by `pythAddress:feedId`.

### Fresh Price Injection via `batchSimulation`

The core mechanism for getting fresh Pyth prices is `executeLensWithPythSimulation()` (`utils/pyth.ts`):

```
1. Collect Pyth feed IDs from the selected vault and collateral routes
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

- **Request batching**: Multiple calls within a 50ms window are grouped by endpoint, with all unique feed IDs combined into a single HTTP request.
- **Caching**: Results are cached for 15 seconds to avoid redundant network requests when multiple vaults share the same Pyth feeds.

### Where Pyth Simulation Is Used

**Bulk vault fetching** (SDK vault services via `useVaults`):
1. Batch-fetch vaults via `batchLensCalls()` (fast path).
2. Collect all Pyth-enabled vaults from selected SDK route steps.
3. Batch re-fetch all Pyth vaults in a single `batchSimulation` via `executeBatchLensWithPythSimulation()`.
4. Replace vault data with simulation results (contains fresh prices in `liabilityPriceInfo` and `collateralPrices[]`).

**Single vault fetching** (SDK vault services via `useVaultRegistry`/`useVaults`):
1. Call `vaultLens.getVaultInfoFull()` normally (fast path).
2. If Pyth detected: re-query with `fetchVaultWithPythSimulation()` → `executeLensWithPythSimulation()`.
3. Replace vault data with simulation result.

**Borrow position loading** (`composables/useEulerAccount.ts`):
1. Call `sdk.portfolioService.fetchPortfolio(..., { populateAll: true })`.
2. Read portfolio positions from SDK `Portfolio` and keep SDK diagnostics beside the portfolio for UI warnings.
3. Transaction paths use SDK `TransactionPlan` processing for Pyth updates before execution.

**Transaction building** (`useEulerTx.ts` + SDK Pyth plugins):
SDK `TransactionPlan` simulation and execution run through the SDK plugin pipeline, which prepends Pyth update batch items when a planned operation needs fresh Pyth prices.

### Design Decisions

1. **Always re-fetch with Pyth**: Even if the initial lens call succeeds, the prices may be stale. The system always re-queries with simulation when Pyth is detected.
2. **Route-scoped feed collection**: Pyth updates are built from the active liability route and enabled collateral routes, not from unrelated oracle branches.
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
          | SDK pricing fields          |
          |  Raw oracle helpers         |
          |  marketPriceUsd fields      |
          |  position USD aggregates    |
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

### Balance Refetch Settling

After each fetch, `updateBalances()` schedules a follow-up run if its inputs (chain, address, registry readiness) changed mid-flight. Two safeguards keep this from looping:

- Address identity is compared **case-insensitively**. Connector-reported addresses are not guaranteed to be EIP-55 checksummed (WalletConnect wallets commonly report lowercase, injected wallets checksum), while the last-fetched address is stored checksummed. A cased compare here once kept the follow-up condition true forever, refetching in an unbounded loop that hung the tab. `useWagmi().address` now normalizes the connector value to checksummed form at the source, so consumers always see canonical casing — the case-insensitive compare stays as defense-in-depth.
- Consecutive follow-up runs are capped (`MAX_CONSECUTIVE_AUTO_REFETCHES`); hitting the cap logs a warning instead of spinning, since legitimate mid-flight changes settle within a couple of rounds.

## Related Documentation

- [Pricing System](./pricing-system.md) — Full pricing architecture details
- [Pyth Oracle Handling](./pyth-oracle-handling.md) — How Pyth oracles affect position loading
- [Vault Labels & Verification](./vault-labels-and-verification.md) — How vault verification affects position visibility
- [Activity Feed](./activity-feed.md) — Portfolio and vault activity history (V3-backed)
- [External Migration Discovery](./external-migration.md) — Aave / Morpho position scanning for Migrate
- [Safe Wallet Compatibility](./safe-wallets.md) — Multisig detection, bundling, and detached execution

### Reactive Update Triggers

The portfolio refreshes when:
- Wallet balances finish loading (`isBalancesLoaded`)
- Lens addresses become available (`isEulerLensAddressesReady`)
- The "show all positions" toggle changes
- The wallet address changes (account switch or debug address)
