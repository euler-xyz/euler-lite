# Intrinsic APY

Intrinsic APY is yield native to the underlying asset — independent of the Euler lending market. Examples: wstETH earns staking yield from Lido, sDAI earns the DAI Savings Rate, Pendle PT tokens earn implied yield from the fixed-rate market.

Euler Lite compounds this intrinsic yield onto the vault's lending/borrowing APY so users see the total effective return.

## Architecture

Intrinsic APY data is **populated onto the vault entity by the SDK at fetch time**. Every vault that goes through `eVaultService.fetchVaults` (or `eulerEarnService.fetchVaults`, `securitizeVaultService.fetchVaults`) carries an `intrinsicApy?: IntrinsicApyInfo` field. Lite reads it directly off the entity — no separate request from the browser, no address-keyed lookup table.

The SDK's `intrinsicApyService` is what actually pulls the data from V3 (`/v3/apys/intrinsic`), which in turn aggregates DefiLlama, Pendle, Securitize, Stablewatch, Ether.fi, Puffer, Spark, Treehouse, Ondo, Renzo, Midas, Yo, and more. Toggle is `populateIntrinsicApy: true` in the fetch options.

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
│   sdk.eVaultService.fetchVaults(chainId, addrs, {                  │
│     populateIntrinsicApy: true, …                                  │
│   })                                                                │
│   sdk.intrinsicApyService.fetchChainIntrinsicApys(chainId)          │
└───────────────────────────────────┬───────────────────────────────┘
                                    │ V3 batched/paginated reads via
                                    │  /api/v3/apys/intrinsic
                                    ▼
                              euler v3 backend
                       (DefiLlama, Pendle, Securitize, …)
```

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

These options flow into every place the registry is filled: `composables/useVaults.ts` for the chain-wide pass, `composables/useVaultRegistry.ts:getOrFetch` for lazy resolution, and `server/utils/vaults-cache.ts` for the warm snapshot pipeline.

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

## User toggle

`composables/useUserSettings.ts` defines `enableIntrinsicApy: boolean` (default `true`). The toggle lives in `components/entities/settings/SettingsModal.vue`. Every call site that displays intrinsic APY reads the flag and passes it into the helper, so toggling off reverts displays to base APY without rebuilding the registry.

## Data refresh cadence

Intrinsic APY values rotate when the V3 backend's source providers update — typically once per epoch / once per day for slow-moving assets, more often for staked-token rates. The data is part of the vault entity, so it refreshes whenever the vault entity does:

- **Snapshot pipeline** (`server/utils/vaults-cache.ts`): rewarmed every minute when V3 is configured, every 5 min otherwise. See [server-side caching](./server-side-caching.md).
- **In-session refresh**: the browsing SDK's QueryClient cache for `queryEVaultInfoFull` is 5 min stale. Subsequent vault reads (e.g. lazy resolution of an off-label vault) re-fetch through the SDK and update `vault.intrinsicApy` in place.

## Adding a new provider

V3 owns the provider list. Add the asset upstream in the V3 backend's intrinsic-APY adapter and it appears in `vault.intrinsicApy` here automatically the next time the snapshot warms.

If a provider needs Lite-specific handling before it is available in V3, keep the data on an explicit current data path such as a labels payload field and wire it into the vault display code with tests. The preferred durable path is upstream into V3.
