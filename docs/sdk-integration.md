# SDK Integration

This document describes how `@eulerxyz/euler-v2-sdk` is initiated inside Euler Lite, how it is configured, how its query cache is wired into vue-query, and the browsing vs fresh entry points that back UI reads and transaction planning.

## Files at a Glance

| File | Purpose |
|------|---------|
| `composables/useEulerSdk.ts` | SDK factory (`getEulerSdk`, `getEulerSdkForChain`, `getEulerSdkFresh`) with Map-based instance cache |
| `utils/sdk-query-policy.ts` | **Single source of truth** — per-query `staleTimeMs` / `formStaleTimeMs` / `invalidateAfterTx`; derived `STALE_TIMES`, `FORM_STALE_TIMES`, `INVALIDATE_AFTER_TX` |
| `utils/sdk-query-cache.ts` | Runtime: shared `QueryClient`, `buildQuery` wrappers, `invalidateSdkQueries` |
| `composables/useEnvConfig.ts` | Resolves env-derived config (incl. `enableV3Backend`) on server and client |
| `server/plugins/app-config.ts` | Reads env at server startup and injects `window.__APP_CONFIG__` |
| `nuxt.config.ts` | Declares the public runtime config keys that mirror env vars |
| `composables/useEulerTx.ts` | Consumes the fresh SDK for plan construction, simulation, and execution |

## SDK Entry Points

The app exposes three SDK entry points, all produced by the same factory in `composables/useEulerSdk.ts`:

- **`getEulerSdk()` — default browsing instance.** Adapter chain is picked by `NUXT_PUBLIC_BROWSER_VAULT_SOURCE` (default `fallback`):
  - `fallback` — V3 primary → onchain secondary. When `enableV3Backend` is false the SDK is built with `disableV3: true` so the chain short-circuits to onchain.
  - `onchain` — direct onchain / direct / subgraph adapters; never touches V3.
  - `v3` — V3 only; SDK build throws if no V3 endpoint is configured.

  Cache wrapper is `sdkBuildQuery`, which applies `STALE_TIMES` (the per-query stale times from `SDK_QUERY_POLICY`). UI surfaces — vault lists, portfolio display, prices, rewards — consume this instance.

- **`getEulerSdkForChain(chainId)` — chain-aware browsing instance.** Chains listed in `ONCHAIN_SDK_CHAINS` use the onchain backend regardless of `NUXT_PUBLIC_BROWSER_VAULT_SOURCE`; all other chains use the default browsing backend. This keeps the browsing cache policy while avoiding V3-backed account/vault/Earn adapters for the pinned chains (typically deprecated chains whose V3 data is gone). Surfaces with an explicit chain id use this entry point.

- **`getEulerSdkFresh()` — form-time / plan-time instance.** Account and vault adapters are pinned to on-chain / subgraph reads regardless of `NUXT_PUBLIC_BROWSER_VAULT_SOURCE` or `enableV3Backend`; rewards use fallback so V3 reward rows can be paired with direct provider proof data. Cache wrapper is `sdkFreshBuildQuery`, which applies `FORM_STALE_TIMES` — pre-resolved `formStaleTimeMs ?? staleTimeMs` per row. Entries that must be live for account discovery, such as `queryAccountVaults`, use `formStaleTimeMs: 0`; plan-critical account/vault reads use shorter form-time windows than browsing reads. Catalogue / labels / prices fall through to the configured stale-time value and continue to hit the shared cache. `composables/useEulerTx.ts` consumes this instance through a small `freshPlanContext()` helper which also fetches a live `Account` so planner entity math reflects the latest block.

All entry points share the same `QueryClient`, so a refetch driven by the fresh instance writes back to the cache that the browsing entry points read from. A subsequent UI render will see the just-refreshed value within its own staleness window.

## Initiation Flow

`composables/useEulerSdk.ts` keeps a module-level `Map<string, Promise<SdkInstance>>` keyed by:

```
freshness | backend | rpcCacheKey | staticCacheKey
```

- `freshness` is `'cached'` or `'fresh'`.
- `backend` is `'fast'` (env-driven via `NUXT_PUBLIC_BROWSER_VAULT_SOURCE`) or `'onchain'` (forced for `ONCHAIN_SDK_CHAINS` browsing reads and the plan-time instance; `freshness` keeps the two apart in the key).
- `rpcCacheKey` is a stable join of `chainId:rpcUrl` for the chains declared by `useEulerAddresses().allowedChainIds`.
- `staticCacheKey` is `JSON.stringify(config)` for the rest of the SDK config (URLs, reward toggles, adapter selection).

On a cache miss, `buildInstance({ backend, buildQuery })` does:

1. Resolves `rpcUrls` from `useEulerAddresses()`. RPC routes through `/api/internal/rpc/<chainId>`, absolute on the server and relative on the client.
2. Builds the static config (see below). For `backend === 'fast'` it picks one of `fallbackAdapterConfig` / `onchainAdapterConfig` / `v3AdapterConfig` from `browserVaultSource`; for `backend === 'onchain'` it forces `onchainAdapterConfig`.
3. Calls `buildEulerSDK({ config, buildQuery, plugins: [createPythPlugin(...), createKeyringPlugin(...), createLiteTosPlugin()] })`.
4. Wires app-side proxy callbacks via `configureAppProxies` — currently `oracleAdapterService.setQueryOracleAdapters` for `/api/internal/oracle-adapters`. The proxy callback is wrapped in `buildQuery('queryOracleAdapters', …)` so its results land in the same shared cache as native SDK queries.

If `buildEulerSDK` rejects, the map entry is cleared so the next caller retries instead of being stuck on a poisoned promise.

## Configuration

There are two layers of configuration: env vars (resolved by `useEnvConfig`) and runtime URLs (read directly from `useRuntimeConfig().public` inside `useEulerSdk`).

### `useEnvConfig`

`composables/useEnvConfig.ts` resolves config in this order (first non-empty wins):

1. `window.__APP_CONFIG__` — injected at runtime by `server/plugins/app-config.ts`. Supports Doppler-injected env vars that change without a rebuild.
2. `useRuntimeConfig().public` — build-time values from `NUXT_PUBLIC_*` env vars (used by static / CDN deployments where the Nitro render hook never fires).
3. Hard-coded `DEFAULTS`.

The runtime config fields include:

- **`enableV3Backend: boolean`** — set to `!!readV3ApiUrl()` on the server and emitted via `window.__APP_CONFIG__`. The client falls back to `useRuntimeConfig().public.enableV3Backend` (`isTruthy`) for static deploys. When `false` *and* `browserVaultSource === 'fallback'`, the SDK is built with `disableV3: true`.
- **`browserVaultSource: 'fallback' | 'onchain' | 'v3'`** — pinned by `NUXT_PUBLIC_BROWSER_VAULT_SOURCE` (default `fallback`). Selects which adapter block (`fallbackAdapterConfig` / `onchainAdapterConfig` / `v3AdapterConfig`) the fast SDK uses. The plan-time SDK ignores this — it's always `onchain`.
- **`eulerInterfacesBranch: string`** — pinned by `EULER_SDK_EULER_INTERFACES_BRANCH` (default `master`). Lite passes it to the SDK ABI service, and `/api/internal/euler-chains` uses the same branch. A configured branch takes precedence over the direct deployments URL.

Chain-aware browsing calls also read `useChainConfig().onchainSdkChainIds`, injected from `ONCHAIN_SDK_CHAINS`. Listed chains use the onchain backend; all other chains use `browserVaultSource`. The list is independent of `DEPRECATED_CHAINS`, which only controls chain-selector collapsing and warm-cache skipping.

The same list also gates the direct (non-SDK) V3 fetches via `composables/useV3ChainGate.ts`: collateral open interest / exposure (`useCollateralOpenInterest`), bad debt (`useVaultBadDebt`), and vault history charts (`VaultOverviewBlockHistory.vue`). `isV3EnabledForChain(chainId)` requires `enableV3Backend` *and* the chain not being in `ONCHAIN_SDK_CHAINS`. This mirrors only the per-chain `ONCHAIN_SDK_CHAINS` override; a global `NUXT_PUBLIC_BROWSER_VAULT_SOURCE=onchain` pin is intentionally not gated, since the V3-only endpoints have no on-chain equivalent to fall back to. Bad debt and history sections hide when gated (V3-only data, no RPC equivalent). Exposure instead degrades to an RPC-derived fallback. Every exposure surface (lend/borrow cards, vault overview, earn surfaces, discovery matrix) routes its state through the shared `resolveVaultExposureDisplay` (in `utils/vault/exposure-display.ts`), which picks the live allocated split when open interest is available and otherwise `buildFallbackVaultExposureDisplay`: vaults where the split is fully determined without open-interest data (nothing utilized, or a vault that accepts a single collateral) show exact values; anything else — including a multi-collateral vault that collapses to one live group because another collateral is missing or ramped out — shows the qualitative backing-asset list rather than misattributing the full amount, with the hover breakdown listing the assets without a value column and a single "USD breakdown unavailable" note. When the split is known (live open interest, or an exact RPC fallback), only collaterals with actual current exposure are listed — accepted collaterals currently backing no borrows are omitted rather than shown as $0 rows, and a vault with nothing utilized collapses to an empty "-". When the split is unknown, the qualitative fallback still lists every accepted collateral (values hidden) so the user sees what the vault *can* be exposed to. Idle (un-utilized) supply is never shown as exposure. (The separate "Collateral exposure" overview/modal section is a configured-collateral list and still shows every collateral with its LTVs and per-collateral current exposure, including $0.) The same fallback covers V3 fetch errors and utilized vaults the indexer returns no rows for, so a lagging indexer degrades the display instead of blanking it.

`useChainConfig().eVaultFetchChunkChainIds`, injected from `EVAULT_FETCH_CHUNK_CHAINS`, is a Lite-side throttle for EVault list reads. Configured chains split browser and server-snapshot `sdk.eVaultService.fetchVaults(...)` calls into small sequential chunks; the SDK package itself is still called through its normal service API.

`useEulerSdk` reads only these — no auto-probing, no user toggle. Switching sources requires changing the env / runtime config. A boot-time warning (`utils/api-url-env.ts:warnIfVaultSourceNeedsV3`) fires when `browserVaultSource` ∈ `{fallback, v3}` but no `V3_API_URL` is configured.

The server-side snapshot builder has its own independent `SERVER_VAULT_CACHE_SOURCE` flag — see [server-side caching](./server-side-caching.md).

### Static SDK config

`buildSdkStaticConfig(backend)` in `useEulerSdk.ts` assembles the rest of the SDK config — every external host is pointed at a same-origin proxy:

| SDK field | Value | Backing endpoint |
|-----------|-------|-----------------|
| `v3ApiUrl`, `tokenlistApiBaseUrl` | `/api/internal` | V3 proxy with exact SDK browser endpoint allowlist (`server/api/internal/v3/[...path].ts`) |
| `eulerInterfacesBranch` | `EULER_SDK_EULER_INTERFACES_BRANCH` (`master`) | Runtime Euler Interfaces ABI source |
| `deploymentsUrl` | `/api/internal/euler-chains` | Local proxy |
| `eulerLabelsBaseUrl` | `/api/internal/labels` | Path-shape labels endpoint (see [server-side caching](./server-side-caching.md)) |
| `rewardsMerklApiUrl` | `/api/internal/proxy/merkl` | Merkl proxy |
| `rewardsFuulApiUrl` | `/api/internal/proxy/fuul` | Fuul proxy |
| `rewardsBrevisApiUrl` | `/api/internal/proxy/incentra/sdk/v1/eulerCampaigns` | Incentra/Brevis proxy |
| `rewardsBrevisProofsApiUrl` | `/api/internal/proxy/incentra/v1/getMerkleProofsBatch` | Incentra/Brevis proxy |
| `accountVaultsSubgraphUrls[chainId]` | `/api/internal/proxy/subgraph/{chainId}` | Goldsky subgraph proxy |
| `vaultTypeSubgraphUrls[chainId]` | `/api/internal/proxy/subgraph/{chainId}` | Goldsky subgraph proxy |
| `rpcUrls[chainId]` | `/api/internal/rpc/{chainId}` | JSON-RPC proxy |
| Adapter block | `fallbackAdapterConfig` / `onchainAdapterConfig` / `v3AdapterConfig` per `browserVaultSource` (default browsing), `onchainAdapterConfig` (`ONCHAIN_SDK_CHAINS` browsing and plan-time) | — |
| `disableV3` | `true` only when the resolved fast source is `fallback` and `!enableV3Backend` | — |

Reward provider toggles (`rewardsEnableMerkl`, `rewardsEnableBrevis`, `rewardsEnableFuul`) are emitted as `false` only when `useDeployConfig()` disables them.

The full object is serialized into `staticCacheKey`, so any change produces a new instance.

## Query Policy (single source of truth)

`utils/sdk-query-policy.ts` owns the per-query policy. One row per `query*` name.
Completeness is test-enforced: `tests/utils/sdk-query-policy.test.ts` builds the
real SDK with a recording `buildQuery` and fails when a wrapped query name has
no policy row (or when a row no longer matches any wrapped name), so an SDK bump
cannot introduce a query that silently inherits `DEFAULT_STALE_TIME_MS`.

```ts
interface SdkQueryPolicyEntry {
  staleTimeMs: number              // QueryClient stale time on the browsing SDK
  formStaleTimeMs?: number         // override on the plan-time SDK; defaults to staleTimeMs
  invalidateAfterTx?: boolean      // invalidated after successful tx
}
```

A few representative rows:

```ts
export const SDK_QUERY_POLICY = {
  // Static catalogue
  queryDeployments:    { staleTimeMs: 5 * MINUTE },
  queryABI:            { staleTimeMs: Infinity },

  // Account/vault reads
  queryAccountVaults:  { staleTimeMs: DEFAULT_STALE_TIME_MS, formStaleTimeMs: 0, invalidateAfterTx: true },
  queryEVaultInfoFull: { staleTimeMs: 5 * MINUTE, formStaleTimeMs: MINUTE, invalidateAfterTx: true },
  queryEVCAccountInfo: { staleTimeMs: 5 * MINUTE, formStaleTimeMs: MINUTE, invalidateAfterTx: true },
  queryV3AccountPositions: { staleTimeMs: DEFAULT_STALE_TIME_MS, invalidateAfterTx: true },

  // Time-sensitive
  queryPythUpdateData: { staleTimeMs: 15 * SECOND },

  // Balances
  queryBalanceOf:      { staleTimeMs: MINUTE, formStaleTimeMs: 15 * SECOND },

  // Position migration: external position balances and authorization state
  // are balance-like (debt accrues per block; the user can sign or revoke
  // authorization mid-flow), so they take short windows + post-tx eviction.
  queryGetPosition:      { staleTimeMs: MINUTE, formStaleTimeMs: 15 * SECOND, invalidateAfterTx: true },
  queryGetAuthorization: { staleTimeMs: MINUTE, formStaleTimeMs: 15 * SECOND, invalidateAfterTx: true },

  // Activity history (V3 via /api/internal/v3). See docs/activity-feed.md.
  queryAccountActivityEvents: { staleTimeMs: ACTIVITY_QUERY_STALE_TIME_MS, invalidateAfterTx: true },
  queryVaultActivityEvents:   { staleTimeMs: ACTIVITY_QUERY_STALE_TIME_MS, invalidateAfterTx: true },
  queryLiquidations:          { staleTimeMs: ACTIVITY_QUERY_STALE_TIME_MS, invalidateAfterTx: true },
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
| `staleTimeMs` | browsing SDK | `QueryClient.fetchQuery({ staleTime: STALE_TIMES[name] ?? DEFAULT_STALE_TIME_MS })`. Cached entries younger than this are returned without re-invoking the SDK. |
| `formStaleTimeMs` | plan-time SDK | Same mechanism but on the fresh SDK's wrapper. Setting `0` forces re-fetch on every plan-time call regardless of cache age. |
| `invalidateAfterTx` | shared QueryClient | Names listed are invalidated via `invalidateSdkQueries(INVALIDATE_AFTER_TX)` after every successful tx, so matching cache entries are stale and active matches refetch. |

`formStaleTimeMs` and `invalidateAfterTx` cover different scopes — `formStaleTimeMs` only affects the plan-time SDK per-fetch behaviour, while `invalidateAfterTx` marks entries stale in the shared cache so the next matching read re-fetches too. Some queries need only one (V3-only plan reads, Pyth simulation, etc.); some need both.

## Runtime: `sdk-query-cache.ts`

`utils/sdk-query-cache.ts` is now just runtime — no policy data lives there. It exports:

```ts
export const sdkQueryClient = new QueryClient()

export const sdkBuildQuery      = buildSdkQuery(STALE_TIMES)
export const sdkFreshBuildQuery = buildSdkQuery(FORM_STALE_TIMES)

export const invalidateSdkQueries = (queryNames: EulerSDKQueryName[]) => { … }
```

`buildSdkQuery(staleTimes)` returns a `BuildQueryFn` that wraps each SDK `query*` method with a `QueryClient.fetchQuery({ queryKey: ['sdk', queryName, serializedArgs], queryFn, staleTime: staleTimes[queryName] ?? DEFAULT_STALE_TIME_MS })` call. The `DEFAULT_STALE_TIME_MS` fall-through is a runtime backstop only — the completeness test keeps the policy table exhaustive, so no shipped query name actually relies on it.

Key properties:

- **One `QueryClient` for everything.** Both SDK instances, the Pyth plugin, and the app-side oracle-adapters proxy all write into the same cache.
- **Args serialized via the SDK's `serializeQueryArgs`** (or per-call `context.getCacheKey`). Non-serializable args throw.
- **`undefined` is rewritten to `null` in / `undefined` out** because vue-query refuses to cache `undefined`.

### Invalidation

`invalidateSdkQueries(queryNames)` walks the QueryClient and invalidates any cache key whose `queryName` matches. Two callers:

- `composables/useEulerTx.ts:finalizeExecution` — fires after every successful tx with `[...INVALIDATE_AFTER_TX]`.
- `composables/cowswap/useCowSwapExecutionCore.ts` — same, post-CoW-swap settlement.

Both import `INVALIDATE_AFTER_TX` directly from `~/utils/sdk-query-policy`. Post-tx invalidation covers both fast V3 account positions (`queryV3AccountPositions`) and fresh/onchain account-vault discovery (`queryAccountVaults`).

### Post-Tx Portfolio Refresh

`composables/useEulerTx.ts:finalizeExecution` invalidates `INVALIDATE_AFTER_TX` and calls `triggerPortfolioRefresh()`. The shared `portfolioRefreshCounter` drives two refreshes:

- `composables/useFreshAccount.ts` reloads the plan-time account snapshot. It races the fast SDK and fresh SDK account reads; fast can fill an empty ref, but the fresh result always wins for the current load cursor.
- `pages/portfolio.vue` calls `updatePositions({ portfolioSource: 'fresh', preemptPortfolio: true })`. That calls `refreshAllPositions(..., { source: 'fresh', preempt: true })`, so `composables/useEulerAccount.ts` loads the visible portfolio through `getEulerSdkFresh()` for the post-tx refresh. `preempt: true` advances the position race guard and resets the refresh coordinator so preempted fast portfolio reads cannot write stale portfolio data or diagnostics over the fresh result.

Normal portfolio page activation and 60-second polling call `updatePositions()` without options, so routine browsing still uses the fast SDK path.

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

Plan builders call `freshPlanContext()` or receive a preloaded account from `useFreshAccount()` and pass that `account` into the SDK. `simulatePlan` and transaction execution use `getEulerSdkFresh()` directly. Prepared-plan review uses the fast SDK so plugin and vault metadata reads can hit the shared cache populated by `useFreshAccount()`.

The fresh `Account` snapshot gives planners correct entity math at the moment of plan construction. Rows with shorter form-time windows keep subsequent SDK reads inside the planner bounded to the freshness required by that data class.

## Where to Extend

| Adding… | Where |
|---------|-------|
| A new env var the SDK needs | `server/plugins/app-config.ts` (server read + `__APP_CONFIG__`), `nuxt.config.ts` (public runtime config key), `composables/useEnvConfig.ts` (resolution order + interface), then pass it into `buildSdkStaticConfig` |
| A new SDK config field | `buildSdkStaticConfig` in `composables/useEulerSdk.ts` (it folds into the existing cache key automatically) |
| A new stale-time policy for an existing query | One row in `SDK_QUERY_POLICY` (`utils/sdk-query-policy.ts`). Derived exports re-compute automatically. |
| A new plan-critical query | Same row, add `formStaleTimeMs: 0` and/or `invalidateAfterTx: true`. |
| A new app-side proxy that SDK calls through | Add a same-origin proxy under `server/api/internal/proxy/...`, point the corresponding SDK config field at it in `buildSdkStaticConfig`. See [server-side caching](./server-side-caching.md) for the shared `external-proxy.ts` helper. |
| A new planner | Add the wrapper in `composables/useEulerTx.ts` using `freshPlanContext()` to get a fresh SDK + `Account` |
