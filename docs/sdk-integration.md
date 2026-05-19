# SDK Integration

This document describes how `@eulerxyz/euler-v2-sdk` is initiated inside Euler Lite, how it is configured, how its query cache is wired into vue-query, and the fast vs fresh instance split that backs UI browsing and transaction planning.

## Files at a Glance

| File | Purpose |
|------|---------|
| `composables/useEulerSdk.ts` | Two-instance SDK factory (`getEulerSdk`, `getEulerSdkFresh`) with Map-based instance cache |
| `utils/sdk-query-cache.ts` | Shared `QueryClient`, `BuildQueryFn` factories, `STALE_TIMES`, and `FRESH_OVERRIDES` |
| `composables/useEnvConfig.ts` | Resolves env-derived config (incl. `enableV3Backend`) on server and client |
| `server/plugins/app-config.ts` | Reads env at server startup and injects `window.__APP_CONFIG__` |
| `nuxt.config.ts` | Declares the public runtime config keys that mirror env vars |
| `composables/useEulerTx.ts` | Consumes the fresh SDK for plan construction, simulation, and execution |

## Two Instances: Fast and Fresh

The app exposes two SDK instances, both produced by the same factory in `composables/useEulerSdk.ts`:

- **`getEulerSdk()` — fast / browsing instance.** When `enableV3Backend` is true, this routes reads through the v3 adapters (`accountServiceAdapter: 'v3'`, etc.) talking to `/api/v3`. When it is false, it falls back to direct on-chain adapters (`'onchain'` / `'subgraph'` / `'direct'`). It uses the default `sdkBuildQuery` cache policy, so reads benefit from sub-minute stale times for hot data (account info, vault info, prices) and long stale times for catalogue data (deployments, ABIs, labels). UI surfaces — vault lists, portfolio display, prices, rewards — consume this instance.

- **`getEulerSdkFresh()` — slow / plan-time instance.** This always uses on-chain adapters regardless of `enableV3Backend`, and uses `sdkFreshBuildQuery`, which forces `staleTime: 0` on plan-critical queries (`queryEVCAccountInfo`, `queryVaultAccountInfo`, `queryEVaultInfoFull`, `queryEulerEarnVaultInfoFull`, `queryBatchSimulation`, `queryBalanceOf`, `queryNativeBalance`, `queryAllowance`, `queryPermit2Allowance`, `queryPythUpdateData`, `queryPythUpdateFee`). Catalogue / labels / prices fall through to the default `STALE_TIMES` and continue to hit the shared cache. `composables/useEulerTx.ts` consumes this instance through a small `freshPlanContext()` helper which also fetches a live `Account` so planner entity math (share/asset conversion, sub-account positions, controller flags) reflects the latest block.

Both instances share the same `QueryClient`, so a refetch driven by the fresh instance writes back to the cache that the fast instance reads from. A subsequent UI render will see the just-refreshed value within its own staleness window.

## Initiation Flow

`composables/useEulerSdk.ts` keeps a module-level `Map<string, Promise<SdkInstance>>` keyed by:

```
freshness | backend | rpcCacheKey | staticCacheKey
```

- `freshness` is `'cached'` or `'fresh'`.
- `backend` is `'v3'` or `'onchain'`.
- `rpcCacheKey` is a stable join of `chainId:rpcUrl` for the chains declared by `useEulerAddresses().allowedChainIds`.
- `staticCacheKey` is `JSON.stringify(config)` for the rest of the SDK config (URLs, reward toggles, adapter selection).

On a cache miss, `buildInstance({ backend, buildQuery })` does:

1. Resolves `rpcUrls` from `useEulerAddresses()`. RPC routes through `/api/rpc/<chainId>`, absolute on the server and relative on the client.
2. Builds the static config (see below), merging in the backend-specific adapter block (`v3AdapterConfig` or `onchainAdapterConfig`).
3. Calls `buildEulerSDK({ config, buildQuery, plugins: [createPythPlugin({ buildQuery })] })`.
4. Wires app-side proxy callbacks via `configureAppProxies` — currently `oracleAdapterService.setQueryOracleAdapters` for `/api/oracle-adapters`. The proxy callback is wrapped in `buildQuery('queryOracleAdapters', …)` so its results land in the same shared cache as native SDK queries.

If `buildEulerSDK` rejects, the map entry is cleared so the next caller retries instead of being stuck on a poisoned promise. If the chain list or any URL changes between calls, the cache key changes and a new instance is built. Older in-flight builds that resolve after the key has moved on do not overwrite the current value because the map only stores promises keyed by current config.

## Configuration

There are two layers of configuration: env vars (resolved by `useEnvConfig`) and runtime URLs (read directly from `useRuntimeConfig().public` inside `useEulerSdk`).

### `useEnvConfig`

`composables/useEnvConfig.ts` resolves config in this order (first non-empty wins):

1. `window.__APP_CONFIG__` — injected at runtime by `server/plugins/app-config.ts`. Supports Doppler-injected env vars that change without a rebuild.
2. `useRuntimeConfig().public` — build-time values from `NUXT_PUBLIC_*` env vars (used by static / CDN deployments where the Nitro render hook never fires).
3. Hard-coded `DEFAULTS`.

The field that drives backend selection is `enableV3Backend: boolean`:

- On the server it is set to `!!readV3ApiUrl()` — the deployment is considered v3-enabled if any of the upstream V3 API URL env vars resolves to a non-empty value.
- The server plugin emits the boolean as part of `window.__APP_CONFIG__`.
- On the client (no `__APP_CONFIG__`, e.g. static deploy) it is derived from `useRuntimeConfig().public.enableV3Backend` via `isTruthy` (`'1' | 'true' | 'yes'`).

`useEulerSdk` reads only this flag — no auto-probing, no user toggle. Switching backends requires changing the env / runtime config.

### Static SDK config

`buildSdkStaticConfig(backend)` in `useEulerSdk.ts` assembles the rest of the SDK config:

- `v3ApiUrl` and `tokenlistApiBaseUrl` — always set to the absolute `/api/v3` proxy path regardless of `backend`, so utility endpoints (tokenlist, deployments resolve) keep working even when adapters are pinned to onchain. The per-service adapter flags are what actually steer reads.
- `deploymentsUrl` — `/api/euler-chains` proxy path.
- `eulerLabelsBaseUrl`, `oracleAdaptersBaseUrl`, `swapApiUrl` — pulled from `useRuntimeConfig().public` if set.
- Reward provider flags — `rewardsEnableMerkl`, `rewardsEnableBrevis`, `rewardsEnableFuul` are only emitted as `false` when the deployment disables them via `useDeployConfig()`; otherwise the SDK applies its own defaults.
- Adapter block — either `v3AdapterConfig` or `onchainAdapterConfig`, merged in last.

The full object is serialized into `staticCacheKey`, so any change to any of these fields produces a new instance.

## Cache Layer

`utils/sdk-query-cache.ts` owns the shared `QueryClient` and the two `BuildQueryFn` factories the SDK uses to wrap every query:

```ts
export const sdkQueryClient = new QueryClient()

const buildSdkQuery = (overrides: Partial<Record<EulerSDKQueryName, number>>): BuildQueryFn =>
  (queryName, fn, _target, context) => async (...args) => {
    const serializedArgs = context?.getCacheKey(args) ?? serializeQueryArgs(args)
    return sdkQueryClient.fetchQuery({
      queryKey: ['sdk', queryName, serializedArgs],
      queryFn: () => fn(...args),
      staleTime: overrides[queryName] ?? STALE_TIMES[queryName] ?? 5 * SECOND,
    })
  }

export const sdkBuildQuery = buildSdkQuery({})
export const sdkFreshBuildQuery = buildSdkQuery(FRESH_OVERRIDES)
```

Key properties:

- **One `QueryClient` for everything.** Both SDK instances, the Pyth plugin, and the app-side oracle-adapters proxy all write into the same cache keyed by `['sdk', queryName, serializedArgs]`.
- **Args are serialized via the SDK's `serializeQueryArgs`** (or the per-call `context.getCacheKey` when the SDK provides one). Non-serializable args throw — by design, so we never silently route different args to the same cache slot.
- **`undefined` is rewritten to `null` on the way in and back to `undefined` on the way out**, because vue-query refuses to cache `undefined`. Callers see no change.

### Where stale times live

`STALE_TIMES` in `utils/sdk-query-cache.ts` is the canonical default policy, organized by data volatility:

| Bucket | Examples | Stale time |
|--------|----------|-----------|
| Catalogue / static | `queryABI`, `queryTokenList` | `Infinity` |
| Deployments / labels / oracle adapters | `queryDeployments`, `queryEulerLabelsEntities`, `queryOracleAdapters`, `queryV3VaultResolve`, `queryEVaultVerifiedArray`, `queryEulerEarnVerifiedArray` | `5 * MINUTE` |
| Vault info / prices / rewards | `queryEVaultInfoFull`, `queryEulerEarnVaultInfoFull`, `queryV3EVaultDetail`, `queryV3EulerEarnDetail`, `queryAssetPriceInfo`, `queryV3RewardsBreakdown`, `queryV3IntrinsicApy` | `20 * SECOND` – `1 * MINUTE` |
| Simulation / pyth update batches | `queryBatchSimulation`, `queryPythUpdateData`, `queryPythUpdateFee` | `10 * SECOND` |
| Hot reads (balances, allowances) | `queryNativeBalance`, `queryTokenBalances`, `queryBalanceOf`, `queryAllowance`, `queryPermit2Allowance` | `5 * SECOND` |
| Anything else | — | `5 * SECOND` (default fallback) |

`FRESH_OVERRIDES` lists the queries that must always be refetched at plan time:

```ts
const FRESH_OVERRIDES = {
  queryEVCAccountInfo: 0,
  queryVaultAccountInfo: 0,
  queryEVaultInfoFull: 0,
  queryEulerEarnVaultInfoFull: 0,
  queryBatchSimulation: 0,
  queryBalanceOf: 0,
  queryNativeBalance: 0,
  queryAllowance: 0,
  queryPermit2Allowance: 0,
  queryPythUpdateData: 0,
  queryPythUpdateFee: 0,
}
```

`sdkFreshBuildQuery` applies these on top of the same `STALE_TIMES`, so cheap reads in the fresh fetch path (labels, ABIs, deployments, prices, rewards) still hit the shared cache and only position-critical queries pay the extra RPC.

### Invalidation

`invalidateSdkQueries(queryNames)` exposes a targeted invalidation pass that walks the QueryClient and drops any cache key whose `queryName` matches. Use it sparingly — most plan-time freshness should come from `FRESH_OVERRIDES`, not manual invalidation.

## Plan-Time Fresh Fetch

`composables/useEulerTx.ts` defines a tiny helper that every planner uses:

```ts
const freshPlanContext = async () => {
  const owner = requireOwner()
  const cid = requireChainId()
  const sdk = await getEulerSdkFresh()
  const fetched = await sdk.accountService.fetchAccount(cid, owner)
  return { sdk, account: fetched.result }
}
```

All ~20 plan builders (`planDeposit`, `planWithdraw`, `planBorrow`, `planRepayFromWallet`, `planSwapCollateral`, `planMultiplyWithSwap`, …) call `freshPlanContext()` and pass `account` into the SDK. `simulatePlan`, `executePlan`, and `preparePlanForReview` use `getEulerSdkFresh()` directly so approval resolution and simulation see the same fresh state.

The fresh `Account` snapshot is what gives planners correct entity math at the moment of plan construction; the zero-stale `FRESH_OVERRIDES` ensure subsequent SDK reads inside the planner (simulate batches, pyth updates, allowance checks) also reflect the latest block.

## Where to Extend

| Adding… | Where |
|---------|-------|
| A new env var the SDK needs | `server/plugins/app-config.ts` (server read + `__APP_CONFIG__`), `nuxt.config.ts` (public runtime config key), `composables/useEnvConfig.ts` (resolution order + interface), then pass it into `buildSdkStaticConfig` |
| A new SDK config field | `buildSdkStaticConfig` in `composables/useEulerSdk.ts` (it folds into the existing cache key automatically) |
| A new stale-time policy for an existing query | `STALE_TIMES` in `utils/sdk-query-cache.ts` |
| A new plan-critical query that must always refetch | `FRESH_OVERRIDES` in `utils/sdk-query-cache.ts` |
| A new app-side proxy that SDK calls through | Add a `setQueryX` wrapper inside `configureAppProxies` in `composables/useEulerSdk.ts`, wrapping the call in `buildQuery('queryX', ...)` so it lands in the shared cache |
| A new planner | Add the wrapper in `composables/useEulerTx.ts` using `freshPlanContext()` to get a fresh SDK + `Account` |
