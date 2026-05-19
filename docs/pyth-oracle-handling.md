# Pyth Oracle Handling

This document describes how euler-lite handles Pyth Network prices in visible read paths and transaction paths.

For the broader pricing pipeline, see [Pricing System](./pricing-system.md).

## Overview

Pyth is a pull-based oracle. A consumer supplies recent update data to `updatePriceFeeds(bytes[])` before reading price-dependent values. In euler-lite this appears in two places:

- Read paths use EVC `batchSimulation` so vault/account lens calls can read fresh simulated prices.
- Transaction paths use SDK `TransactionPlan` simulation and execution, where SDK processing adds Pyth update batch items when the planned operation needs them.

## Feed Collection

Vault entities expose SDK oracle adapter data. `utils/pyth.ts` uses `collectPythFeedsFromAdapters` from the SDK to collect feeds from those adapters.

Main helpers:

- `collectPythFeedsFromVaults(vaults)` collects and deduplicates feeds for a list of vaults.
- `collectPythFeedsForHealthCheck(liabilityVault, collateralVaultAddresses)` collects the liability vault debt-pricing feeds plus the collateral-pricing feeds that participate in the health check.

Feeds are deduplicated by `pythAddress:feedId`.

## Hermes Updates

`fetchPythUpdateData(feedIds, endpoint)` fetches binary update payloads through the server-side `/api/pyth/updates` proxy. The proxy forwards to the configured Hermes endpoint and keeps browser clients away from upstream URL details.

The client helper:

- batches calls made within a short collection window,
- normalizes feed ids,
- caches update payloads briefly,
- returns cached data on recoverable network failures where possible.

## Read Path: Lens Simulation

Visible vault/account reads can use EVC batch simulation to include fresh Pyth updates before the lens call:

```text
collect feeds
  -> fetch Hermes update data
  -> build Pyth update batch items
  -> append lens batch item
  -> EVC batchSimulation
  -> decode the lens result
```

`executeLensWithPythSimulation()` handles a single lens call. `executeBatchLensWithPythSimulation()` merges feeds across many entries, builds Pyth update items once, chunks lens calls, and returns a keyed result map.

These helpers use static simulation only. They do not send transactions.

## Batch Item Builders

`utils/pyth.ts` provides two read-path builders:

| Function | Input | Output |
|----------|-------|--------|
| `buildPythBatchItems(vaults, providerUrl, hermesEndpoint)` | Vault entities | `{ items, totalFee }` |
| `buildPythBatchItemsFromFeeds(feeds, providerUrl, hermesEndpoint)` | Pre-collected feeds | `{ items, totalFee }` |

Both builders group feeds by Pyth contract, fetch update data, read `getUpdateFee(updateData)`, and encode `updatePriceFeeds(updateData)` batch items.

## Transaction Path

Transaction planning goes through SDK `TransactionPlan` helpers in `useEulerTx.ts`. Before simulation, review preparation, and execution, Lite applies operation guards and then delegates to SDK execution service methods:

- `simulateTransactionPlan(...)`
- `resolveRequiredApprovals(...)`
- `executeTransactionPlan(...)`

The SDK plugin pipeline processes the plan before runtime work. Pyth update items are inserted into EVC batches by the SDK when the plan and vault/account context require fresh Pyth prices.

## Error Handling

Read-path Pyth helpers return empty update sets or `undefined` decoded results when they cannot build or simulate updates. Callers can continue rendering with available data and let the next refresh attempt recover.

Transaction-path errors are surfaced through SDK simulation and execution results. Forms show simulation errors through `useTransactionPlanSimulation()`, and the review modal blocks confirmation when plan preparation fails.

## Files

| File | Purpose |
|------|---------|
| `utils/pyth.ts` | Hermes fetching, read-path batch item building, lens simulation helpers |
| `entities/oracle.ts` | Oracle adapter decoding helpers and Pyth feed types used by UI code |
| `server/api/pyth/updates.ts` | Server-side Hermes proxy endpoint |
| `composables/useEulerTx.ts` | SDK `TransactionPlan` simulation, preparation, and execution wrapper |
| `composables/useTransactionPlanSimulation.ts` | Form-level simulation state and error formatting |
| `docs/pricing-system.md` | Full pricing architecture and vault/account read flow |
