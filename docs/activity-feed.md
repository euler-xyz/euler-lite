# Activity Feed

This document describes how Euler Lite loads, filters, enriches, and renders protocol activity for vault overviews and the portfolio Activity tab.

## Intent

Activity is a V3-backed history surface. Lite does not invent an activity indexer: it calls the Euler V2 SDK `activityService`, which talks to upstream V3 through the same-origin `/api/internal/v3` proxy. Lite owns UI availability gating, display filtering, liquidation enrichment, and presentation.

## Architecture

```
Vault overview accordion  ─┐
Portfolio /activity tab   ─┤
                           ▼
              useActivityAvailability
                (V3 chain gate + SDK capabilities)
                           ▼
                    ActivityFeed.vue
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
  useActivityFeed   useActivityLiquidationDetails   activity-display.ts
  (events pages)    (/v3/liquidations enrich)       (filters, labels, groups)
         │                 │
         └────────┬────────┘
                  ▼
     getEulerSdkForChain → activityService
                  ▼
        /api/internal/v3 → upstream V3
```

Two scopes:

| Scope | SDK call | Upstream path |
| ----- | -------- | ------------- |
| Account | `fetchAccountActivityEvents` | `GET /v3/activity/accounts/0x…/events` |
| Vault | `fetchVaultActivityEvents` | `GET /v3/activity/vaults/{chainId}/0x…/events?vaultType=…` |
| Liquidation enrich | `fetchLiquidations` | `GET /v3/liquidations` |

There are no dedicated Nuxt activity routes beyond the shared V3 proxy allowlist in `server/utils/v3-proxy.ts`.

## UI surfaces

| Surface | Path | Scope |
| ------- | ---- | ----- |
| EVK / Earn / Securitize vault overview | `VaultOverviewBlockActivity.vue` | Vault (`vaultType` = `evk` / `earn` / `securitize`) |
| Portfolio Activity tab | `pages/portfolio/activity.vue` | Account (`useEffectiveAddress()` — spy address when spy mode is active) |

Vault accordion mounts closed by default. It stays hidden until availability is known (or the capability check fails and retry UI is shown). Runtime `coverage.status === 'unsupported'` with no category filter selected hides the whole section / portfolio tab.

## Availability gating

`useActivityAvailability(scope, chainId)`:

1. Rejects invalid chain ids (`invalid-chain`).
2. Requires `useV3ChainGate().isV3EnabledForChain` (`v3-disabled` when gated off).
3. Reads `activityService.getCapabilities()` and `getScopeSupport(...)`.
4. Treats scope support `unknown` as requestable — response coverage is authoritative. Only explicit `unsupported` hides the surface.

`shouldRender` is true when supported **or** when the capability check failed (`capability-check-failed`), so users can retry instead of losing the section silently.

Portfolio tab visibility is coordinated through `usePortfolioActivityRuntimeSupport` (`useState` keyed by `owner:chainId`) between `pages/portfolio.vue` and `pages/portfolio/activity.vue`.

## Feed loading

`useActivityFeed({ scope, enabled, categories, limit = 25 })`:

- Always sends scope-specific `eventTypes` from `getDisplayActivityEventTypes`.
- Omits `categories` from the request when the UI selection is empty (= union of chip categories, not “every upstream category”).
- Dedupes pages by `event.id` (`mergeActivityEvents`).
- Stale head: `ACTIVITY_QUERY_STALE_TIME_MS` = 60s (`utils/sdk-query-policy.ts`). Reopening a stale feed refreshes while keeping last-good rows.
- Invalidates via `subscribeToSdkQueryInvalidations` on `queryAccountActivityEvents` / `queryVaultActivityEvents` (both `invalidateAfterTx: true`).
- Auto display-fill: up to **3** append pages when client filtering empties the visible set (`AUTO_DISPLAY_FILL_PAGE_LIMIT`).
- Pagination guard: append throws if `nextCursor` does not advance.
- Mid-flight context changes are discarded via `activeRequestId` + `buildActivityFeedContextKey`.

Returned state flags worth knowing: `hasColdError` (error + no rows), `hasStaleError` (error + retained rows), `isPartial` / `isSyncing` / `isUnsupported` from coverage meta.

## Filters and defaults

### Vault

`getVaultActivityFilterOptions` / `getDefaultVaultActivityFilter`:

| Vault type | Default chip | Categories |
| ---------- | ------------ | ---------- |
| `evk` | `lending-borrowing` | lending + borrowing; also governance; liquidations |
| `earn` | `lending` | lending; governance (no liquidations chip) |
| `securitize` | `lending` | lending; governance |

**Default is not “All”.** Opening a vault Activity section fetches lending(+borrowing) first. Selecting nothing (“All”) resolves to the union of that vault type’s option categories.

Borrowability of the live vault does not remove historical borrowing filters.

### Portfolio (account)

- Unfiltered query categories: `lending`, `borrowing`, `liquidations` (`getAccountActivityCategories`).
- Visible chips: **liquidations only** (`getAccountActivityFilterOptions`). Lending/borrowing remain in the All query; verbs and tx grouping communicate them.
- The SDK `account` category is deliberately omitted — none of its event types are displayed on Lite.
- Categories present in label maps but not queried here: `swaps`, `rewards`, and account-scope `governance`.

## Display event-type allowlists

`getDisplayActivityEventTypes` + `filterActivityEventsForDisplay` keep only Lite-relevant types.

**Account:** `deposit`, `withdraw`, `borrow`, `repay`, `pull_debt`, `liquidation`.

**EVK vault:** lending/borrowing ops plus `transfer`, `debt_socialized`, `pull_debt`, `liquidation`, `approval`, `balance_forwarder_status`, `convert_fees`, and governance setters (`set_caps`, `set_ltv`, hooks, IRM, fees, …).

**Earn / Securitize:** deposit/withdraw/transfer plus their reallocation / queue / governance ops (see `VAULT_ACTIVITY_EVENT_TYPES` in `utils/activity-display.ts`).

Explicitly excluded noise (covered by tests): `interest_accrued`, `accrue_interest`, `mint`, `burn`, earn `update_last_total_assets` / `update_lost_assets`.

### Client-side pairing rules

After the allowlist, the feed always runs with `hideZeroLiquidations: true` and also:

1. Drops **zero-value liquidations** (both assets + collateral `amountRaw` are `0`; malformed values are kept).
2. Drops **violator `repay`** events that match a same-tx liquidation (same account as violator + matching assets amount). Liquidator repayments are kept.
3. Drops **shadow `transfer`** of shares that pair with deposit/withdraw/liquidation/reallocation in the same tx (same share address + amountRaw).

Pairing re-runs on the merged raw event list, so a shadow transfer on page 1 can disappear after a later page brings its paired deposit.

## Liquidation enrichment

`useActivityLiquidationDetails({ events })` is a second, fail-soft pass:

- Groups events by `chainId:vault`, windows min/max event unix ± 1s.
- Pages `/v3/liquidations` at limit 100, max **3** pages.
- Join key: `chainId:txHash:vault:violator:collateral:repayAssets` (lowercased). Event payload falls back to account / collateral asset / assets amountRaw.
- Fetch failures roll back the covered-window claim; rows stay unenriched with no feed-level error.

Display prefers `repayAssetsUsd`, converted collateral (+ symbol), `collateralAssetsUsd`, and signed `bonusUsd` (with unit-of-account valuation fallback).

### Grouping

- **Portfolio:** `groupActivityEventsByTransaction` → `chainId:txHash`. Header is `"Liquidation transaction"` when any event is a liquidation, else `"Transaction"`. Groups collapse after 3 events.
- **Vault:** one synthetic group per event (no tx bundling).

## Proxy and ops constraints

Allowlisted GET patterns only (`server/utils/v3-proxy.ts`):

- `/v3/activity/accounts/0x[40hex]/events`
- `/v3/activity/vaults/[chainId]/0x[40hex]/events`
- `/v3/liquidations`

Anything else 404s at the edge. Proxy logs keep chain / vault / categories / eventTypes / safe ranges and intentionally omit account / violator / liquidator addresses. Backoff keys redact owner/vault path segments.

## Fail modes

| Condition | Behavior |
| --------- | -------- |
| V3 disabled / invalid chain / unsupported scope | Hide surface |
| Capability check throws | Keep surface + retry |
| Cold feed error | Error card + retry |
| Refresh error with rows | Stale warning; keep last events |
| Liquidation enrich failure | Silent; rows unenriched |
| Coverage `unsupported` + All filters | Hide tab / vault section |
| Coverage `unsupported` + specific chip | “Not available for selected categories” |
| Coverage `partial` / `syncing` | Banners / empty messaging |

## Common pitfalls

1. Vault default filter ≠ All — documenting “shows every category on open” is wrong.
2. Portfolio chip row ≠ query set — All still fetches lending + borrowing + liquidations.
3. Event-type filtering is both a request `eventTypes` list and a client allowlist.
4. Liquidation USD/bonus comes from a separate endpoint; absence is expected and silent.
5. Account feed groups by transaction; vault feed does not.
6. `ActivityAddress` supports `linkKind: 'spy'`, but current display helpers only emit `explorer` / `vault` links.

## Files

| File | Purpose |
| ---- | ------- |
| `composables/useActivityFeed.ts` | Paged event loading, stale refresh, display-fill |
| `composables/useActivityAvailability.ts` | Capability / scope gating |
| `composables/useActivityLiquidationDetails.ts` | Fail-soft `/v3/liquidations` enrichment |
| `composables/useActivityNowMs.ts` | Shared 60s clock for relative timestamps |
| `composables/usePortfolioActivityRuntimeSupport.ts` | Portfolio tab visibility coordination |
| `utils/activity-display.ts` | Filters, allowlists, labels, grouping, liquidation display |
| `components/entities/activity/ActivityFeed.vue` | Orchestrator |
| `components/entities/activity/ActivityEventRow.vue` | Row / expand / registry metadata |
| `components/entities/activity/ActivityCategoryFilters.vue` | All + multi-select chips |
| `components/entities/activity/ActivityAddress.vue` | Explorer / vault / spy links |
| `components/entities/vault/overview/VaultOverviewBlockActivity.vue` | Vault accordion host |
| `pages/portfolio/activity.vue` | Account feed page |
| `server/utils/v3-proxy.ts` | Allowlist + log redaction |
| `utils/sdk-query-policy.ts` | 60s stale + post-tx invalidation |
