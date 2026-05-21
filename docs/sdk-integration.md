# SDK Integration

This document describes how `@eulerxyz/euler-v2-sdk` is initiated inside Euler Lite, how it is configured, how its query cache is wired into vue-query, and the fast vs fresh instance split that backs UI browsing and transaction planning.

## Files at a Glance

| File | Purpose |
|------|---------|
| `composables/useEulerSdk.ts` | Two-instance SDK factory (`getEulerSdk`, `getEulerSdkFresh`) with Map-based instance cache |
| `utils/sdk-query-policy.ts` | **Single source of truth** — per-query `staleTimeMs` / `formStaleTimeMs` / `invalidateAfterTx`; derived `STALE_TIMES`, `FORM_STALE_TIMES`, `INVALIDATE_AFTER_TX` |
| `utils/sdk-query-cache.ts` | Runtime: shared `QueryClient`, `buildQuery` wrappers, `invalidateSdkQueries` |
| `composables/useEnvConfig.ts` | Resolves env-derived config (incl. `enableV3Backend`) on server and client |
| `server/plugins/app-config.ts` | Reads env at server startup and injects `window.__APP_CONFIG__` |
| `nuxt.config.ts` | Declares the public runtime config keys that mirror env vars |
| `composables/useEulerTx.ts` | Consumes the fresh SDK for plan construction, simulation, and execution |

## Two Instances: Fast and Fresh

The app exposes two SDK instances, both produced by the same factory in `composables/useEulerSdk.ts`:

- **`getEulerSdk()` — fast / browsing instance.** Adapter chain is picked by `NUXT_PUBLIC_BROWSER_VAULT_SOURCE` (default `fallback`):
  - `fallback` — V3 primary → onchain secondary. When `enableV3Backend` is false the SDK is built with `disableV3: true` so the chain short-circuits to onchain.
  - `onchain` — direct onchain / direct / subgraph adapters; never touches V3.
  - `v3` — V3 only; SDK build throws if no V3 endpoint is configured.

  Cache wrapper is `sdkBuildQuery`, which applies `STALE_TIMES` (the per-query stale times from `SDK_QUERY_POLICY`). UI surfaces — vault lists, portfolio display, prices, rewards — consume this instance.

- **`getEulerSdkFresh()` — form-time / plan-time instance.** Pinned to on-chain / direct / subgraph adapters regardless of `NUXT_PUBLIC_BROWSER_VAULT_SOURCE` or `enableV3Backend`. Cache wrapper is `sdkFreshBuildQuery`, which applies `FORM_STALE_TIMES` — pre-resolved `formStaleTimeMs ?? staleTimeMs` per row, so plan-critical reads (`queryEVCAccountInfo`, `queryVaultAccountInfo`, `queryEVaultInfoFull`, `queryEulerEarnVaultInfoFull`, `queryBatchSimulation`, balance/allowance probes, Pyth update data) are forced to `staleTime: 0`. Catalogue / labels / prices fall through to the same row's `staleTimeMs` and continue to hit the shared cache. `composables/useEulerTx.ts` consumes this instance through a small `freshPlanContext()` helper which also fetches a live `Account` so planner entity math reflects the latest block.

Both instances share the same `QueryClient`, so a refetch driven by the fresh instance writes back to the cache that the fast instance reads from. A subsequent UI render will see the just-refreshed value within its own staleness window.

## Initiation Flow

`composables/useEulerSdk.ts` keeps a module-level `Map<string, Promise<SdkInstance>>` keyed by:

```
freshness | backend | rpcCacheKey | staticCacheKey
```

- `freshness` is `'cached'` or `'fresh'`.
- `backend` is `'fast'` (env-driven via `NUXT_PUBLIC_BROWSER_VAULT_SOURCE`) or `'onchain'` (forced for the plan-time instance).
- `rpcCacheKey` is a stable join of `chainId:rpcUrl` for the chains declared by `useEulerAddresses().allowedChainIds`.
- `staticCacheKey` is `JSON.stringify(config)` for the rest of the SDK config (URLs, reward toggles, adapter selection).

On a cache miss, `buildInstance({ backend, buildQuery })` does:

1. Resolves `rpcUrls` from `useEulerAddresses()`. RPC routes through `/api/rpc/<chainId>`, absolute on the server and relative on the client.
2. Builds the static config (see below). For `backend === 'fast'` it picks one of `fallbackAdapterConfig` / `onchainAdapterConfig` / `v3AdapterConfig` from `browserVaultSource`; for `backend === 'onchain'` it forces `onchainAdapterConfig`.
3. Calls `buildEulerSDK({ config, buildQuery, plugins: [createPythPlugin(...), createKeyringPlugin(...), createLiteTosPlugin()] })`.
4. Wires app-side proxy callbacks via `configureAppProxies` — currently `oracleAdapterService.setQueryOracleAdapters` for `/api/oracle-adapters`. The proxy callback is wrapped in `buildQuery('queryOracleAdapters', …)` so its results land in the same shared cache as native SDK queries.

If `buildEulerSDK` rejects, the map entry is cleared so the next caller retries instead of being stuck on a poisoned promise.

## Configuration

There are two layers of configuration: env vars (resolved by `useEnvConfig`) and runtime URLs (read directly from `useRuntimeConfig().public` inside `useEulerSdk`).

### `useEnvConfig`

`composables/useEnvConfig.ts` resolves config in this order (first non-empty wins):

1. `window.__APP_CONFIG__` — injected at runtime by `server/plugins/app-config.ts`. Supports Doppler-injected env vars that change without a rebuild.
2. `useRuntimeConfig().public` — build-time values from `NUXT_PUBLIC_*` env vars (used by static / CDN deployments where the Nitro render hook never fires).
3. Hard-coded `DEFAULTS`.

Two fields drive adapter selection:

- **`enableV3Backend: boolean`** — set to `!!readV3ApiUrl()` on the server and emitted via `window.__APP_CONFIG__`. The client falls back to `useRuntimeConfig().public.enableV3Backend` (`isTruthy`) for static deploys. When `false` *and* `browserVaultSource === 'fallback'`, the SDK is built with `disableV3: true`.
- **`browserVaultSource: 'fallback' | 'onchain' | 'v3'`** — pinned by `NUXT_PUBLIC_BROWSER_VAULT_SOURCE` (default `fallback`). Selects which adapter block (`fallbackAdapterConfig` / `onchainAdapterConfig` / `v3AdapterConfig`) the fast SDK uses. The plan-time SDK ignores this — it's always `onchain`.

`useEulerSdk` reads only these — no auto-probing, no user toggle. Switching sources requires changing the env / runtime config. A boot-time warning (`utils/api-url-env.ts:warnIfVaultSourceNeedsV3`) fires when `browserVaultSource` ∈ `{fallback, v3}` but no `V3_API_URL` is configured.

The server-side snapshot builder has its own independent `SERVER_VAULT_CACHE_SOURCE` flag — see [server-side caching](./server-side-caching.md).

### Static SDK config

`buildSdkStaticConfig(backend)` in `useEulerSdk.ts` assembles the rest of the SDK config — every external host is pointed at a same-origin proxy:

| SDK field | Value | Backing endpoint |
|-----------|-------|-----------------|
| `v3ApiUrl`, `tokenlistApiBaseUrl` | `/api/v3` | V3 proxy (`server/api/v3/[...path].ts`) |
| `deploymentsUrl` | `/api/euler-chains` | Local proxy |
| `eulerLabelsBaseUrl` | `/api/labels` | Path-shape labels endpoint (see [server-side caching](./server-side-caching.md)) |
| `rewardsMerklApiUrl` | `/api/proxy/merkl` | Merkl proxy |
| `rewardsFuulApiUrl` | `/api/proxy/fuul` | Fuul proxy |
| `rewardsBrevisApiUrl` | `/api/proxy/incentra/sdk/v1/eulerCampaigns` | Incentra/Brevis proxy |
| `rewardsBrevisProofsApiUrl` | `/api/proxy/incentra/v1/getMerkleProofsBatch` | Incentra/Brevis proxy |
| `accountVaultsSubgraphUrls[chainId]` | `/api/proxy/subgraph/{chainId}` | Goldsky subgraph proxy |
| `vaultTypeSubgraphUrls[chainId]` | `/api/proxy/subgraph/{chainId}` | Goldsky subgraph proxy |
| `rpcUrls[chainId]` | `/api/rpc/{chainId}` | JSON-RPC proxy |
| Adapter block | `fallbackAdapterConfig` / `onchainAdapterConfig` / `v3AdapterConfig` per `browserVaultSource` (fast instance), `onchainAdapterConfig` (plan-time instance) | — |
| `disableV3` | `true` only when the resolved fast source is `fallback` and `!enableV3Backend` | — |

Reward provider toggles (`rewardsEnableMerkl`, `rewardsEnableBrevis`, `rewardsEnableFuul`) are emitted as `false` only when `useDeployConfig()` disables them.

The full object is serialized into `staticCacheKey`, so any change produces a new instance.

## Query Policy (single source of truth)

`utils/sdk-query-policy.ts` owns the per-query policy. One row per `query*` name:

```ts
interface SdkQueryPolicyEntry {
  staleTimeMs: number              // QueryClient stale time on the browsing SDK
  formStaleTimeMs?: number         // override on the plan-time SDK; defaults to staleTimeMs
  invalidateAfterTx?: boolean      // explicitly evicted at form mount + post-tx
}
```

A few representative rows:

```ts
export const SDK_QUERY_POLICY = {
  // Static catalogue
  queryDeployments:    { staleTimeMs: 5 * MINUTE },
  queryABI:            { staleTimeMs: Infinity },

  // Plan-critical chain reads
  queryEVaultInfoFull: { staleTimeMs: 5 * MINUTE, formStaleTimeMs: 0, invalidateAfterTx: true },
  queryEVCAccountInfo: { staleTimeMs: 5 * MINUTE, formStaleTimeMs: 0, invalidateAfterTx: true },

  // Time-sensitive
  queryPythUpdateData: { staleTimeMs: 10 * SECOND, formStaleTimeMs: 0 },

  // Balances
  queryBalanceOf:      { staleTimeMs: 5 * SECOND,  formStaleTimeMs: 0 },
}
```

Three derived exports drop out (pre-resolved so the runtime is a flat lookup):

```ts
export const STALE_TIMES:        Partial<Record<EulerSDKQueryName, number>>  // for sdkBuildQuery
export const FORM_STALE_TIMES:   Partial<Record<EulerSDKQueryName, number>>  // for sdkFreshBuildQuery
export const INVALIDATE_AFTER_TX: readonly EulerSDKQueryName[]               // for invalidateSdkQueries
```

`FORM_STALE_TIMES[name]` resolves to `policy.formStaleTimeMs ?? policy.staleTimeMs` per row; no two-table lookup at runtime.

### What each field controls

| field | scope | runtime effect |
|---|---|---|
| `staleTimeMs` | browsing SDK | `QueryClient.fetchQuery({ staleTime: STALE_TIMES[name] ?? 5_000 })`. Cached entries younger than this are returned without re-invoking the SDK. |
| `formStaleTimeMs` | plan-time SDK | Same mechanism but on the fresh SDK's wrapper. Setting `0` forces re-fetch on every plan-time call regardless of cache age. |
| `invalidateAfterTx` | shared QueryClient | Names listed get evicted via `invalidateSdkQueries(INVALIDATE_AFTER_TX)` at form mount and after every successful tx, so the next browsing read re-fetches. |

`formStaleTimeMs` and `invalidateAfterTx` look redundant but cover different scopes — `formStaleTimeMs` only affects the plan-time SDK's per-fetch behaviour, while `invalidateAfterTx` evicts entries from the shared cache so the browsing SDK's *next* read re-fetches too. Some queries need only one (V3-only plan reads, Pyth simulation, etc.); some need both.

## Runtime: `sdk-query-cache.ts`

`utils/sdk-query-cache.ts` is now just runtime — no policy data lives there. It exports:

```ts
export const sdkQueryClient = new QueryClient()

export const sdkBuildQuery      = buildSdkQuery(STALE_TIMES)
export const sdkFreshBuildQuery = buildSdkQuery(FORM_STALE_TIMES)

export const invalidateSdkQueries = (queryNames: EulerSDKQueryName[]) => { … }
```

`buildSdkQuery(staleTimes)` returns a `BuildQueryFn` that wraps each SDK `query*` method with a `QueryClient.fetchQuery({ queryKey: ['sdk', queryName, serializedArgs], queryFn, staleTime: staleTimes[queryName] ?? 5_000 })` call. Non-listed queries fall through to the 5-second default — exercised by `tests/utils/sdk-query-cache.test.ts`.

Key properties:

- **One `QueryClient` for everything.** Both SDK instances, the Pyth plugin, and the app-side oracle-adapters proxy all write into the same cache.
- **Args serialized via the SDK's `serializeQueryArgs`** (or per-call `context.getCacheKey`). Non-serializable args throw.
- **`undefined` is rewritten to `null` in / `undefined` out** because vue-query refuses to cache `undefined`.

### Invalidation

`invalidateSdkQueries(queryNames)` walks the QueryClient and drops any cache key whose `queryName` matches. Two callers:

- `composables/useEulerTx.ts:finalizeExecution` — fires after every successful tx with `[...INVALIDATE_AFTER_TX]`.
- `composables/cowswap/useCowSwapExecutionCore.ts` — same, post-CoW-swap settlement.

Both import `INVALIDATE_AFTER_TX` directly from `~/utils/sdk-query-policy`. Most plan-time freshness should come from `formStaleTimeMs: 0`, not manual invalidation.

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

All ~20 plan builders call `freshPlanContext()` and pass `account` into the SDK. `simulatePlan`, `executePlan`, and `preparePlanForReview` use `getEulerSdkFresh()` directly so approval resolution and simulation see the same fresh state.

The fresh `Account` snapshot gives planners correct entity math at the moment of plan construction; the zero-`formStaleTimeMs` rows ensure subsequent SDK reads inside the planner (simulate batches, pyth updates, allowance checks) also reflect the latest block.

## Where to Extend

| Adding… | Where |
|---------|-------|
| A new env var the SDK needs | `server/plugins/app-config.ts` (server read + `__APP_CONFIG__`), `nuxt.config.ts` (public runtime config key), `composables/useEnvConfig.ts` (resolution order + interface), then pass it into `buildSdkStaticConfig` |
| A new SDK config field | `buildSdkStaticConfig` in `composables/useEulerSdk.ts` (it folds into the existing cache key automatically) |
| A new stale-time policy for an existing query | One row in `SDK_QUERY_POLICY` (`utils/sdk-query-policy.ts`). Derived exports re-compute automatically. |
| A new plan-critical query | Same row, add `formStaleTimeMs: 0` and/or `invalidateAfterTx: true`. |
| A new app-side proxy that SDK calls through | Add a same-origin proxy under `server/api/proxy/...`, point the corresponding SDK config field at it in `buildSdkStaticConfig`. See [server-side caching](./server-side-caching.md) for the shared `external-proxy.ts` helper. |
| A new planner | Add the wrapper in `composables/useEulerTx.ts` using `freshPlanContext()` to get a fresh SDK + `Account` |
