# Intrinsic APY

Intrinsic APY is yield native to the underlying asset — independent of the Euler lending market. Examples: wstETH earns staking yield from Lido, sDAI earns the DAI Savings Rate, Pendle PT tokens earn implied yield from the fixed-rate market.

Euler Lite includes this intrinsic yield in APY displays so users see the effective economics of the asset. For supplied assets it increases effective return; for borrowed assets it increases effective borrowing cost.

## Architecture

Intrinsic APY data is **populated onto the vault entity by the SDK at fetch time**. Every vault that goes through `eVaultService.fetchVaults` (or `eulerEarnService.fetchVaults`, `securitizeVaultService.fetchVaults`) carries an `intrinsicApy?: IntrinsicApyInfo` field. Display helpers read that field — they do not look up APY by asset address themselves.

The browsing SDK does not use the SDK's V3 adapter alone. `useEulerSdk` wraps it with `createYuzuIntrinsicApyService` (`utils/yuzu-intrinsic-apy.ts`) and installs the wrapper via `servicesOverrides.intrinsicApyService`. The wrapper still reads V3 (`/v3/apys/intrinsic` through `/api/internal/v3`), then overlays Lite-owned rows from `GET /api/internal/proxy/intrinsic-apy-overrides?chainId=`. A matching override **wins** over V3 for that asset.

```text
┌───────────────────────────────────────────────────────────────────┐
│                       Lite call sites                              │
│  withVaultIntrinsicApy(base, vault, enabled)                       │
│  getVaultIntrinsicApy(vault, enabled)                              │
│  getVaultIntrinsicApyInfo(vault, enabled)                          │
└───────────────────────────────────┬───────────────────────────────┘
                                    │ reads vault.intrinsicApy
                                    ▼
┌───────────────────────────────────────────────────────────────────┐
│                     SDK-owned EVault / EulerEarn                    │
│            intrinsicApy?: { apy, provider, source? }                │
└───────────────────────────────────┬───────────────────────────────┘
                                    │ populated by
                                    ▼
┌───────────────────────────────────────────────────────────────────┐
│   createYuzuIntrinsicApyService (browser SDK only)                 │
│     V3 IntrinsicApyService  +  /api/internal/proxy/                │
│                                intrinsic-apy-overrides?chainId=    │
└───────────────────────────────────┬───────────────────────────────┘
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
        /api/internal/v3/apys/intrinsic    Lite override proxy
        (DefiLlama, Pendle, Securitize, …) (HyperEVM 999, Monad 143)
```

The **server snapshot SDK is unwrapped**. `/api/internal/vaults` therefore ships V3-only intrinsic APY. First paint restores those snapshot values through `buildSnapshotIntrinsicApyAdapter`. The silent client refresh (`getEulerSdkForChain` + `populateIntrinsicApy: true`) applies Lite overlays. HyperEVM / Monad APY that exists only as an override can lag the snapshot by one hydrate cycle.

Toggle is `populateIntrinsicApy: true` in the fetch options.

## Where it's populated

`utils/sdk-fetch-options.ts:liteVaultFetchOptions` enables intrinsic APY for every Lite vault fetch:

```ts
export const liteVaultFetchOptions = {
  populateMarketPrices: true,
  populateCollaterals: true,
  populateStrategyVaults: true,
  populateRewards: true,
  populateIntrinsicApy: true,   // ← here
  eVaultFetchOptions: {
    populateMarketPrices: true,
    populateCollaterals: true,
    populateRewards: true,
    populateIntrinsicApy: true,
  },
}

export const liteSecuritizeVaultFetchOptions = {
  populateMarketPrices: true,
  populateRewards: true,
  populateIntrinsicApy: true,
}
```

These options flow into every place the registry is filled: `composables/useVaults.ts` for the chain-wide pass, `composables/useVaultRegistry.ts:getOrFetch` for lazy resolution, and `server/utils/vaults-cache.ts` for the warm snapshot pipeline. The snapshot builder sets the same `populateIntrinsicApy: true` flag but uses the unwrapped server SDK, so snapshot rows do not include Lite overlays.

## Helpers

`utils/vault-intrinsic-apy.ts` exposes three pure functions:

```ts
import type { IntrinsicApyInfo } from '@eulerxyz/euler-v2-sdk'

export const EMPTY_INTRINSIC_APY: IntrinsicApyInfo = { apy: 0, provider: '' }

export function getVaultIntrinsicApyInfo(vault, enabled): IntrinsicApyInfo
export function getVaultIntrinsicApy(vault, enabled): number
export function withVaultIntrinsicApy(baseApy: number, vault, enabled: boolean): number
```

- `enabled` is the per-user toggle from `useUserSettings().settings.value.enableIntrinsicApy`. When false, the helpers return zero (or `baseApy` for `withVaultIntrinsicApy`).
- `withVaultIntrinsicApy` applies the canonical compound formula `base + (1 + base/100) * intrinsic`. Same formula for supply and borrow; the role lives at the call site (e.g. `borrowApy - rewards` vs `supplyApy + rewards`).
- `getVaultIntrinsicApyInfo` returns the full info object including `provider` and `source` for use in APY-breakdown modals.

The SDK exposes an equivalent on its side: `computeSupplyApyBreakdown(vault)` returns `{ lending, intrinsicApy, rewards, total }` with the compounding pre-applied. Use whichever fits the call site; both produce the same numbers for supply.

## Borrow-side display

Borrow views call the same helper path, but the UI copy treats intrinsic APY as cost-side yield. `VaultBorrowItem.vue` passes `getVaultIntrinsicApyInfo()` into `VaultApyModal.vue` (with `mode: 'borrow'`); in borrow mode that modal describes intrinsic APY as "yield intrinsic to the borrowed asset ... which increases effective borrowing cost".

The borrow APY modal uses the same compounded intrinsic helper as supply-side displays, then subtracts borrow rewards:

```text
total borrow APY = borrowing APY + (1 + borrowing APY / 100) * intrinsic APY - reward APY
```

Pair-level Net APY and Max ROE screens use the same compounded helper for consistency with vault headline APYs. When changing borrow-side APY copy, keep the direction explicit: intrinsic yield on the debt asset makes borrowing more expensive, while borrow rewards reduce the displayed cost.

## User toggle

`composables/useUserSettings.ts` defines `enableIntrinsicApy: boolean` (default `true`). The toggle lives in `components/entities/settings/SettingsModal.vue`. Every call site that displays intrinsic APY reads the flag and passes it into the helper, so toggling off reverts displays to base APY without rebuilding the registry.

## Lite override proxy

`GET|HEAD /api/internal/proxy/intrinsic-apy-overrides?chainId=` is the Lite-owned overlay for assets V3 does not yet cover. It is not the shared `external-proxy.ts` forwarder: the handler aggregates a fixed set of origin URLs and returns `IntrinsicApyOverrideRow[]`.

| Constraint | Behavior |
|---|---|
| Supported chains | `999` (HyperEVM) and `143` (Monad). Any other `chainId` returns `[]` without origin fetches. Missing/NaN `chainId` is `400`. |
| Cache key | `String(chainId)` only. Extra query parameters must not bust the origin cache. |
| TTL | 5 minutes in-process (`createTtlCache`, `maxEntries: 2`) plus `Cache-Control: public, max-age=300`. Nitro route rules add CDN `s-maxage=300, stale-while-revalidate=600`. This path is cacheable — `shouldForceNoStoreForPath` leaves it to those route rules. |
| In-flight | One origin aggregation per `chainId`; concurrent callers coalesce. |
| HEAD | Sets headers and returns; does not fetch origins. |
| Rate limit | `intrinsic-apy-overrides-proxy`, 300 requests / 60 s. |
| Browser wrapper cache | Separate 5-minute per-chain map in `createYuzuIntrinsicApyService`. |

HyperEVM (`999`) fans out eight origin groups (Valantis, Kinetiq, Hyperbeat, LHYPE, LSTHYPE, Noon, Pendle kHYPE, DefiLlama) through `Promise.all` + `safe()`. A single origin failure logs and drops that row; an all-source miss caches `[]` until TTL expiry. Monad (`143`) is DefiLlama-only for `yzPrime`; an upstream throw is **not** cached, so the next request retries.

Override fetch is fail-soft against V3: `Promise.allSettled` in the wrapper. A matching override replaces the V3 row. A failed override fetch leaves a successful V3 result in place. If V3 fails and there is no override row, the wrapper throws.

Do not add a Lite override when V3 already publishes the asset. The durable path is still the V3 adapter. Lite rows exist only for the hardcoded HyperEVM / Monad addresses in `server/api/internal/proxy/intrinsic-apy-overrides.get.ts`.

### Adding a Lite override

1. Add the origin URL and address in `intrinsic-apy-overrides.get.ts` (HyperEVM `fetchHyperevm` or Monad `monadDefillamaSources`).
2. Keep parsers in `utils/yuzu-intrinsic-apy.ts` when the payload is not a plain number (`extractValantisApy`, `extractHyperbeatWeightedApr`).
3. Cover cache isolation and origin failure in `tests/server/intrinsic-apy-overrides.test.ts`.
4. Confirm `chainId` is the cache key: two requests that differ only by extra query params must share one origin pass.

## Data refresh cadence

Intrinsic APY values rotate when the V3 backend's source providers update — typically once per epoch / once per day for slow-moving assets, more often for staked-token rates. The data is part of the vault entity, so it refreshes whenever the vault entity does:

- **Snapshot pipeline** (`server/utils/vaults-cache.ts`): rewarmed every minute when V3 is configured, every 5 min otherwise. V3-only; see [server-side caching](./server-side-caching.md).
- **In-session refresh**: the browsing SDK's QueryClient cache for `queryEVaultInfoFull` is 5 min stale. Subsequent vault reads (e.g. lazy resolution of an off-label vault) re-fetch through the wrapped SDK and update `vault.intrinsicApy` in place, including Lite overlays.
- **Override proxy / wrapper**: 5 min each, keyed by chain. Changing an origin row is not visible until both TTLs expire.

## Adding a V3 provider

V3 owns the general provider list. Add the asset upstream in the V3 backend's intrinsic-APY adapter and it appears in `vault.intrinsicApy` here automatically the next time the snapshot warms. Prefer that over a Lite override.

For form previews, the intrinsic component is recomputed against projected market rates and included in the before/after contribution breakdown. See [Projected Yield](./projected-yield.md).

## Troubleshooting

| Symptom | Cause |
|---|---|
| HyperEVM / Monad APY missing on first paint, then appears | Snapshot is V3-only; wait for the silent client refresh, or hard-refresh after the override proxy is warm. |
| Override APY stuck after an origin fix | In-process TTL still serving the previous chain result, including a cached empty HyperEVM miss. Wait 5 minutes or restart Nitro. |
| Non-999/143 chain shows no overlay | Expected: the proxy returns `[]` and V3 is the only source. |
