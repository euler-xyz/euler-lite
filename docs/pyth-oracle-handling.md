# Pyth Oracle Handling

This document provides a general overview of how euler-lite integrates with Pyth Network oracles, covering both the read path (simulation for price display) and the write path (real transactions that update prices on-chain).

For the detailed pricing system architecture and how Pyth fits into vault/account loading, see [Pricing System](./pricing-system.md).

## Overview

**Pyth Network** is a pull-based oracle — unlike push-based oracles (Chainlink, Chronicle) where prices are updated on-chain by keepers, Pyth requires consumers to explicitly push fresh price data before reading it. This fundamentally changes how the app handles pricing for Pyth-dependent vaults.

## How Pyth Differs from Push-Based Oracles

| Aspect | Push-Based (Chainlink) | Pull-Based (Pyth) |
|--------|----------------------|-------------------|
| **Price updates** | Keepers push periodically | Consumer must push before reading |
| **Staleness** | Minutes to hours | ~2 minutes (configurable `maxStaleness`) |
| **On-chain cost** | Keeper pays gas | Consumer pays update fee |
| **Read pattern** | Direct read anytime | Must update first, then read |
| **Failure mode** | Stale but available | `queryFailure: true` if not updated |

**Practical impact**: When a vault uses Pyth oracles, the app must update Pyth prices before every lens read (simulation) and before every transaction (real).

## Architecture in euler-lite

### Feed Collection

`collectPythFeedIds()` in `entities/oracle.ts` recursively traverses the oracle configuration tree returned by VaultLens:

```
oracleDetailedInfo
  ├── EulerRouter
  │   ├── fallbackOracleInfo → recurse
  │   └── resolvedOraclesInfo[] → recurse each
  │       ├── CrossAdapter
  │       │   ├── oracleBaseCrossInfo → recurse
  │       │   └── oracleCrossQuoteInfo → recurse
  │       │       └── PythOracle → extract { pythAddress, feedId }
  │       └── PythOracle → extract { pythAddress, feedId }
  └── (other adapters ignored)
```

The traversal is depth-limited (default 3) and deduplicates feeds by `pythAddress:feedId`.

### Data Types

```typescript
// Decoded from oracle configuration
interface PythOracleInfo {
  pyth: string         // Pyth contract address
  base: string         // Base token address
  quote: string        // Quote token address
  feedId: string       // Hex-encoded feed identifier
  maxStaleness: bigint // Maximum allowed age (seconds)
  maxConfWidth: bigint // Maximum confidence interval width
}

// Simplified feed reference used for batching
interface PythFeed {
  pythAddress: string  // Pyth contract address
  feedId: string       // Feed identifier
}
```

### Hermes API

Price update data is fetched from the Pyth Hermes API via the server-side proxy endpoint `/api/pyth/updates`:

```
GET /api/pyth/updates?ids[]={feedId1}&ids[]={feedId2}&...
```

The proxy forwards requests to the upstream Hermes endpoint (`PYTH_HERMES_URL/v2/updates/price/latest`), validating feed ID format and enforcing rate limits (600 requests/min). This routing avoids CORS restrictions and keeps the Hermes URL (which may contain credentials) out of the browser. See [Development Guide - Pyth Proxy](./development-guide.md#pyth-proxy-endpoint-details) for details.

Returns binary update payloads that can be passed to the on-chain `updatePriceFeeds()` function.

## Performance Optimizations

### Request Batching

`fetchPythUpdateData()` collects all requests within a **100ms window** and combines them into a single call to the `/api/pyth/updates` server proxy. Multiple vaults requesting different feeds in quick succession result in one network request instead of many.

### Update Data Cache

Hermes responses are cached for **15 seconds**. Within this window, repeated requests for the same feeds return cached data without a network round-trip.

### Price Cache

`fetchPythPrices()` caches price values with a configurable TTL (default 15 seconds). This is used for display purposes where slightly stale prices are acceptable.

### Deduplication Across Vaults

`collectPythFeedsFromVaults()` collects feeds from multiple vaults and deduplicates by `pythAddress:feedId`, ensuring each unique feed is only updated once even when shared across vaults.

## Read Path: Simulation

When the app needs to read price-dependent data (vault info, account health), it uses EVC `batchSimulation` to inject fresh Pyth prices into a simulated context:

```
1. Collect all Pyth feed IDs from vault's oracle tree
2. Fetch latest update data from Hermes API
3. Build batch items:
   [pythContract.updatePriceFeeds(data), ..., lensContract.getVaultInfoFull(vault)]
4. Execute EVC.batchSimulation(items) as a staticCall
5. Pyth prices are updated in the simulation context
6. Lens call reads fresh prices
7. Decode and return the lens result
```

This is a `staticCall` — no transaction is sent, no gas is spent. The state changes exist only within the simulation.

The generic helper `executeLensWithPythSimulation()` in `utils/pyth.ts` handles this for any lens call (VaultLens, AccountLens, etc.).

For the full read path details (vault loading, account loading, bulk fetching), see [Pricing System - Pyth Oracle Handling](./pricing-system.md#pyth-oracle-handling).

## Write Path: Transaction Updates

When submitting real transactions that interact with Pyth-priced vaults, the app prepends Pyth update calls to the EVC batch so prices are fresh when the vault reads them.

### `preparePythUpdates()`

Located in `composables/useEulerOperations/helpers.ts`, this is the entry point for all transaction Pyth updates:

```typescript
const preparePythUpdates = async (vaultAddresses: string[], sender: Address) => {
  const vaults = vaultAddresses.map(addr => registryGetVault(addr))
  return await buildPythUpdateCalls(vaults, providerUrl, hermesEndpoint, sender)
}
// Returns: { calls: EVCCall[], totalFee: bigint }
```

### `buildPythUpdateCalls()`

Located in `utils/pyth.ts`, this builds the actual EVC calls:

1. Collect all Pyth feeds from the provided vaults
2. Fetch latest update data from Hermes
3. Group feeds by Pyth contract address (there may be multiple Pyth deployments)
4. For each Pyth contract:
   - Query `getUpdateFee(updateData)` to determine the required fee
   - Encode `updatePriceFeeds(updateData)` call
   - Create an `EVCCall` with the fee as `value`
5. Return all calls and the total fee sum

### How Updates Are Integrated

Pyth update calls are **prepended** to the EVC batch, ensuring prices are fresh before the main operation executes:

```typescript
const evcCalls = [/* main operation calls */]

const { calls: pythCalls } = await preparePythUpdates([vaultAddr], userAddr)
if (pythCalls.length) {
  evcCalls.unshift(...pythCalls)
}

const totalValue = sumCallValues(evcCalls)  // Includes Pyth fees

await writeContractAsync({
  address: evcAddress,
  abi: EVC_ABI,
  functionName: 'batch',
  args: [evcCalls],
  value: totalValue,  // Fee sent as msg.value
})
```

### Which Operations Include Pyth Updates

| Operation | Vaults Checked |
|-----------|---------------|
| **Borrow** | Collateral vault + borrow vault |
| **BorrowBySaving** | Savings vault + borrow vault |
| **Withdraw** (from sub-account) | Collateral vault |
| **Redeem** | Vault being redeemed |
| **DisableCollateral** | Collateral vault |
| **Swap** (collateral/debt) | Source + target vaults |
| **Multiply** | Collateral + borrow + swap target vaults |

**Not included**: Supply, repay, savings repay, savings full repay, and swap full repay operations don't need Pyth updates — supply/repay don't trigger health checks, and full-repay variants end with `disableController` which bypasses the health check.

## Batch Building Utilities

`utils/pyth.ts` provides three batch building functions for different contexts:

| Function | Output Format | Use Case |
|----------|--------------|----------|
| `buildPythUpdateCalls()` | `EVCCall[]` | Real transactions (includes `onBehalfOfAccount`) |
| `buildPythBatchItems()` | `BatchItem[]` | Simulations via `batchSimulation` |
| `buildPythBatchItemsFromFeeds()` | `BatchItem[]` | Simulations with pre-collected feeds |

Additional utilities:
- `sumCallValues(calls)` — sums the `value` field across all calls for `msg.value`
- `priceToAmountOutMid(price)` — converts Pyth price format to 18-decimal bigint

## Error Handling

All Pyth operations fail gracefully:

- `preparePythUpdates()` catches errors and returns `{ calls: [], totalFee: 0n }` — the operation proceeds without Pyth updates (may fail if vault requires them)
- `fetchPythUpdateData()` returns cached data on network errors
- `executeLensWithPythSimulation()` returns `undefined` on simulation failure, allowing callers to fall back to non-Pyth data

## Files

| File | Purpose |
|------|---------|
| `utils/pyth.ts` | Core Pyth utilities (Hermes API, batch building, simulation helper) |
| `abis/pyth.ts` | Pyth contract ABI (`getUpdateFee`, `updatePriceFeeds`) |
| `entities/oracle.ts` | Oracle tree decoding, `collectPythFeedIds()` |
| `entities/oracle-providers.ts` | Oracle provider logo mapping |
| `composables/useEulerOperations/helpers.ts` | `preparePythUpdates()` for transaction building |
| `composables/useEulerAccount.ts` | `hasPythOracles()` for portfolio loading |
| `docs/pricing-system.md` | Full pricing architecture with detailed Pyth read path |
