# Pyth Oracle Handling

This document describes how euler-lite handles Pyth Network prices in visible read paths and transaction paths.

For the broader pricing pipeline, see [Pricing System](./pricing-system.md).

## Overview

Pyth is a pull-based oracle. A consumer supplies recent update data to `updatePriceFeeds(bytes[])` before reading price-dependent values. In euler-lite this appears in two places:

- Read paths use EVC `batchSimulation` so vault/account lens calls can read fresh simulated prices.
- Transaction paths use SDK `TransactionPlan` simulation and execution, where SDK processing adds Pyth update batch items when the planned operation needs them.

## Feed Collection

EVault entities expose selected SDK oracle routes. `utils/pyth.ts` uses
`collectPythFeedsFromRouteSteps` from the SDK to collect feeds from the
asset-to-UoA route and the collateral routes.

Main helpers:

- `collectPythFeedsFromVaults(vaults)` collects and deduplicates feeds for a list of vaults.
- `collectPythFeedsForHealthCheck(liabilityVault, collateralVaultAddresses)` collects the liability vault debt-pricing feeds plus the collateral-pricing feeds that participate in the health check.

Feeds are deduplicated by `pythAddress:feedId`.

## Hermes Updates

`fetchPythUpdateData(feedIds, endpoint)` fetches binary update payloads through the server-side `/api/internal/pyth/updates` proxy. The proxy authenticates to `https://hermes.pyth.network` with `PYTH_API_KEY` and keeps the credential out of the browser.

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

Transaction planning goes through SDK `TransactionPlan` helpers in `useEulerTx.ts`. Reviewed execution applies operation guards and delegates planning, plugin processing, deterministic materialization, and EOA receipt sequencing to the SDK.

- `simulateTransactionPlan(...)`
- `resolveRequiredApprovals(...)`
- `materializeExecution(...)`, finalization, and `executeMaterialized(...)`

The SDK plugin pipeline inserts Pyth update items into EVC batches when the plan and vault/account context require fresh prices. Lite seals those preview items as bounded dynamic slots. For an EOA sequence with static approval or migration-grant requests before the Pyth-bearing EVC request, the SDK first executes and receipts only that static prefix. Lite then refreshes and structurally verifies Pyth immediately before finalizing the suffix, and hands that suffix back to `executeMaterialized`. The initial schema permits one Pyth-bearing request per execution and rejects a dynamic signature slot in its prefix. Safe has one atomic handoff, so refresh remains immediately before that envelope is sent.

## Error Handling

Read-path Pyth helpers return empty update sets or `undefined` decoded results when they cannot build or simulate updates. Callers can continue rendering with available data and let the next refresh attempt recover.

Transaction-path errors are surfaced through reviewed execution preparation and execution. Forms show eager simulation errors through `useTransactionPlanSimulation()`. The reviewed execution seals bounded Pyth refresh slots, refreshes them only after the synchronous duplicate guard is acquired and any static EOA prefix has confirmed, and blocks the Pyth-bearing wallet handoff if refresh or slot verification fails. Expiry of the short review/cache TTL during an already-started prerequisite receipt wait does not invalidate that accepted sequence. Pyth remains absent from the user-facing review.

## Files

| File | Purpose |
|------|---------|
| `utils/pyth.ts` | Hermes fetching, read-path batch item building, lens simulation helpers |
| `entities/oracle.ts` | Oracle adapter decoding helpers and Pyth feed types used by UI code |
| `server/api/internal/pyth/updates.get.ts` | Server-side Hermes proxy endpoint |
| `composables/useEulerTx.ts` | SDK `TransactionPlan` planning, preview preparation, and simulation helpers |
| `composables/useReviewedExecution.ts` | Pyth preview-data collection, execution-time refresh, and slot verification integration |
| `composables/useTransactionPlanSimulation.ts` | Form-level simulation state and error formatting |
| `docs/pricing-system.md` | Full pricing architecture and vault/account read flow |
