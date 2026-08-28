# SDK Integration

This document describes how `@eulerxyz/euler-v2-sdk` is initiated inside Euler Lite, how it is configured, how its query cache is wired into vue-query, and the browsing vs fresh entry points that back UI reads and transaction planning.

## Files at a Glance

| File | Purpose |
|------|---------|
| `composables/useEulerSdk.ts` | SDK factory (`getEulerSdk`, `getEulerSdkForChain`, `getEulerSdkFresh`) with Map-based instance cache |
| `utils/sdk-query-policy.ts` | **Single source of truth** — per-query `staleTimeMs` / `formStaleTimeMs` / `invalidateAfterTx`; derived `STALE_TIMES`, `FORM_STALE_TIMES`, `INVALIDATE_AFTER_TX` |
| `utils/sdk-query-cache.ts` | Runtime: shared `QueryClient`, `buildQuery` wrappers, invalidation, and post-indexer query generations |
| `composables/useEnvConfig.ts` | Resolves env-derived config (incl. `enableV3Backend`) on server and client |
| `server/plugins/app-config.ts` | Reads env at server startup and injects `window.__APP_CONFIG__` |
| `nuxt.config.ts` | Declares the public runtime config keys that mirror env vars |
| `composables/useEulerTx.ts` | Consumes the fresh SDK for plan construction, preview preparation, and simulation |
| `composables/useReviewedExecution.ts` | Builds sealed reviewed executions and owns the app-facing preparation and wallet-handoff boundary |

## Reviewed-execution SDK release gate

The reviewed execution depends only on public SDK APIs and deliberately does not copy SDK internals into Lite. Its pinned published SDK release must provide:

- public whole-plan plugin prefetch and processing;
- fail-closed processing for required plugins;
- Pyth prefetch evidence containing feed IDs, payloads, fees, and publish times;
- public ABI-aware migration authorization slot preparation and signature insertion encoders;
- deterministic `materializeExecution`, pure `finalizeMaterializedExecution`, and byte-stable `executeMaterialized` boundaries;
- migration simulation that models authorization without executing it; and
- public simulation documentation linked from the relevant prepare, simulate, execute, and direct-call surfaces.

Lite's migration compiler, plugin-data collector, and finalizer fail closed when these capabilities are unavailable instead of emulating them. During sealing, Lite invokes the SDK materializer with pinned Permit2 nonce/deadline/expiration values and the reviewed EVC address, then independently rejects any request-byte, signature-slot, or insertion-coordinate disagreement with its richer effect projection. For an EOA with static prerequisites before its single Pyth-bearing request, Lite gives the reviewed static prefix to `executeMaterialized`, refreshes and finalizes Pyth only after the SDK receipts that prefix, then gives the finalized suffix to `executeMaterialized`; the SDK owns receipt sequencing within both segments. Other EOA executions use one already-finalized vector. Awaited pre-prompt hooks verify the wallet binding and exact request. Safe transport seals its atomic EIP-5792 envelope while retaining the calls-ID status adapter and current-session detachment behavior.

## SDK Entry Points

The app exposes three SDK entry points, all produced by the same factory in `composables/useEulerSdk.ts`:

- **`getEulerSdk()` — default browsing instance.** Adapter chain is picked by `NUXT_PUBLIC_BROWSER_VAULT_SOURCE` (default `fallback`):
  - `fallback` — V3 primary → onchain secondary. When `enableV3Backend` is false the SDK is built with `disableV3: true` so the chain short-circuits to onchain.
  - `onchain` — direct onchain / direct / subgraph adapters; never touches V3.
  - `v3` — V3 only; SDK build throws if no V3 endpoint is configured.

  Cache wrapper is `sdkBuildQuery`, which applies `STALE_TIMES` (the per-query stale times from `SDK_QUERY_POLICY`). UI surfaces — vault lists, portfolio display, prices, rewards — consume this instance.

- **`getEulerSdkForChain(chainId)` — chain-aware browsing instance.** Chains listed in `ONCHAIN_SDK_CHAINS` use the onchain backend regardless of `NUXT_PUBLIC_BROWSER_VAULT_SOURCE`; all other chains use the default browsing backend. This keeps the browsing cache policy while avoiding V3-backed account/vault/Earn adapters for the pinned chains (typically deprecated chains whose V3 data is gone). Surfaces with an explicit chain id use this entry point.

- **`getEulerSdkFresh()` — form-time / plan-time instance.** Account and vault adapters are pinned to on-chain / subgraph reads regardless of `NUXT_PUBLIC_BROWSER_VAULT_SOURCE` or `enableV3Backend`; rewards use fallback so V3 reward rows can be paired with direct provider proof data. Cache wrapper is `sdkFreshBuildQuery`, which applies `FORM_STALE_TIMES` — pre-resolved `formStaleTimeMs ?? staleTimeMs` per row. Plan-critical account and vault reads use shorter form-time windows than browsing reads: for example, `queryAccountVaults` uses 1 minute and balance-like migration reads use 15 seconds. Catalogue / labels / prices fall through to the configured stale-time value and continue to hit the shared cache. `composables/useEulerTx.ts` consumes this instance through a small `freshPlanContext()` helper which also fetches an `Account` through those onchain adapters.

  Pinning the adapters changes the *data source*, not the cache. `sdkFreshBuildQuery` still runs through the shared `QueryClient`, and `freshPlanContext()` does not invalidate before fetching, so a plan-time `Account` is onchain-backed but only as fresh as its `FORM_STALE_TIMES` rows allow — up to a minute old for `queryAccountVaults`. Immediate reviewed-execution invalidation (`invalidateAfterTx`) marks those rows stale so a later idle read re-fetches after the user's own state changes; the fresh instance alone does not. Ordinary invalidation joins an in-flight `fetchQuery` for the same key. The post-indexer portfolio refresh uses a new query generation, so reads triggered after the subgraph reaches the confirmed block cannot join the pre-catch-up request. Neither entry point by itself guarantees a latest-block read.

All entry points share the same `QueryClient`, so a refetch driven by the fresh instance writes back to the cache that the browsing entry points read from. A subsequent UI render will see the just-refreshed value within its own staleness window.

## Initiation Flow

`composables/useEulerSdk.ts` keeps a module-level `Map<string, Promise<SdkInstance>>` keyed by:

```
freshness | backend | rpcCacheKey | staticCacheKey | keyring:keyringCacheKey
```

- `freshness` is `'cached'` or `'fresh'`.
- `backend` is `'fast'` (env-driven via `NUXT_PUBLIC_BROWSER_VAULT_SOURCE`) or `'onchain'` (forced for `ONCHAIN_SDK_CHAINS` browsing reads and the plan-time instance; `freshness` keeps the two apart in the key).
- `rpcCacheKey` is a stable join of `chainId:rpcUrl` for the chains declared by `useEulerAddresses().allowedChainIds`.
- `staticCacheKey` is `JSON.stringify(config)` for the rest of the SDK config (URLs, reward toggles, adapter selection).
- `keyringCacheKey` is `JSON.stringify(buildSdkKeyringHookTargets())`. The Keyring plugin is built with the hook targets resolved at build time, so this segment keeps a target-list change from reusing an instance wired to the old targets.

On a cache miss, `buildInstance({ backend, buildQuery })` does:

1. Resolves `rpcUrls` from `useEulerAddresses()`. RPC routes through `/api/internal/rpc/<chainId>`, absolute on the server and relative on the client.
2. Builds the static config (see below). For `backend === 'fast'` it picks one of `fallbackAdapterConfig` / `onchainAdapterConfig` / `v3AdapterConfig` from `browserVaultSource`; for `backend === 'onchain'` it forces `onchainAdapterConfig`.
3. Calls `buildEulerSDK({ config, buildQuery, plugins: [createPythPlugin(...), createKeyringPlugin(...), createLiteTosPlugin()] })`.
4. Wires app-side proxy callbacks via `configureAppProxies` — currently `oracleAdapterService.setQueryOracleAdapters` for `/api/internal/oracle-adapters`. The proxy callback is wrapped in `buildQuery('queryOracleAdapters', …)` so its results land in the same shared cache as native SDK queries. How that map is displayed (and why a miss must not refetch) is in [Oracle Adapter Display](./oracle-adapter-display.md).

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
- **`eulerInterfacesBranch: string`** — pinned by `EULER_SDK_EULER_INTERFACES_BRANCH` (default `master`). `/api/internal/euler-chains` and `/api/internal/abis` resolve their upstreams from the same branch. Explicit URL overrides (`NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL`, `NUXT_PUBLIC_CONFIG_EULER_ABIS_BASE_URL`) take precedence over the branch — they are the emergency repoint levers when the default GitHub source is unavailable.

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
| `eulerInterfacesBranch` | `EULER_SDK_EULER_INTERFACES_BRANCH` (`master`) | Branch selection for the euler-interfaces manifests (browser ABI fetches themselves go through the proxy below) |
| `deploymentsUrl` | `/api/internal/euler-chains` | Local proxy |
| ABI fetches (`setQueryABI` in `configureAppProxies`) | `/api/internal/abis/{contract}` | Runtime ABI proxy (`AccountLens`/`VaultLens`/`UtilsLens` allowlist) |
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
  invalidateAfterTx?: boolean      // participates in post-transaction invalidation
}
```

A few representative rows:

```ts
export const SDK_QUERY_POLICY = {
  // Static catalogue
  queryDeployments:    { staleTimeMs: 5 * MINUTE },
  queryABI:            { staleTimeMs: Infinity },

  // Account/vault reads
  queryAccountVaults:  { staleTimeMs: DEFAULT_STALE_TIME_MS, formStaleTimeMs: MINUTE, invalidateAfterTx: true },
  queryEVaultInfoFull: { staleTimeMs: 5 * MINUTE, formStaleTimeMs: MINUTE, invalidateAfterTx: true },
  queryEVCAccountInfo: { staleTimeMs: 5 * MINUTE, formStaleTimeMs: MINUTE, invalidateAfterTx: true },
  queryV3AccountPositions: { staleTimeMs: DEFAULT_STALE_TIME_MS, invalidateAfterTx: true },

  // Time-sensitive
  queryPythUpdateData: { staleTimeMs: 30 * SECOND },

  // Balances
  queryBalanceOf:      { staleTimeMs: MINUTE, formStaleTimeMs: 15 * SECOND, invalidateAfterTx: true },

  // Position migration
  queryListPositions: { staleTimeMs: DEFAULT_STALE_TIME_MS, formStaleTimeMs: MINUTE, invalidateAfterTx: true },
  queryListTargets:   { staleTimeMs: DEFAULT_STALE_TIME_MS, formStaleTimeMs: MINUTE, invalidateAfterTx: true },
  queryGetPosition:      { staleTimeMs: MINUTE, formStaleTimeMs: 15 * SECOND, invalidateAfterTx: true },
  queryGetAuthorization: { staleTimeMs: MINUTE, formStaleTimeMs: 15 * SECOND, invalidateAfterTx: true },
  queryEulerTargetVaultData:   { staleTimeMs: 5 * MINUTE, formStaleTimeMs: MINUTE },
  queryEulerSourceVaultAssets: { staleTimeMs: 5 * MINUTE },

  // Activity history (V3 via /api/internal/v3). See docs/activity-feed.md.
  queryAccountActivityEvents: { staleTimeMs: ACTIVITY_QUERY_STALE_TIME_MS, invalidateAfterTx: true },
  queryVaultActivityEvents:   { staleTimeMs: ACTIVITY_QUERY_STALE_TIME_MS, invalidateAfterTx: true },
  queryLiquidations:          { staleTimeMs: ACTIVITY_QUERY_STALE_TIME_MS, invalidateAfterTx: true },
}
```

Migration discovery (`queryListPositions`, `queryListTargets`) can reuse results for 5 minutes while browsing but refreshes after 1 minute in forms and after a successful transaction. External balances and authorization state are more volatile: debt accrues per block and authorization can be granted or revoked during the flow, so `queryGetPosition` and `queryGetAuthorization` use 1-minute browsing / 15-second form windows plus post-transaction invalidation. Euler target-vault data is governance configuration; source-vault asset addresses are effectively immutable, so those reads use longer windows.

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
| `invalidateAfterTx` | shared QueryClient | Names listed are marked stale via `invalidateSdkQueries(INVALIDATE_AFTER_TX)` after reviewed submission and CoW permit hard-cancellation. After the reviewed submission's subgraph catch-up, `advanceSdkQueryGeneration(INVALIDATE_AFTER_TX)` invalidates again and assigns subsequent reads distinct cache keys. Standalone migration grant/revoke receipts do not run either boundary. |

`formStaleTimeMs` and `invalidateAfterTx` cover different scopes — `formStaleTimeMs` only affects the plan-time SDK per-fetch behaviour, while `invalidateAfterTx` marks entries stale in the shared cache so a later idle matching read re-fetches too. Some queries need only one (V3-only plan reads, Pyth simulation, etc.); some need both.

## Runtime: `sdk-query-cache.ts`

`utils/sdk-query-cache.ts` owns the cache runtime; query policy remains in `utils/sdk-query-policy.ts`. It exports:

```ts
export const sdkQueryClient = new QueryClient()

export const sdkBuildQuery      = buildSdkQuery(STALE_TIMES)
export const sdkFreshBuildQuery = buildSdkQuery(FORM_STALE_TIMES)

export const invalidateSdkQueries = (queryNames: EulerSDKQueryName[]) => { … }
export const advanceSdkQueryGeneration = (queryNames: EulerSDKQueryName[]) => { … }
```

`buildSdkQuery(staleTimes)` returns a `BuildQueryFn` that wraps each SDK `query*` method with a `QueryClient.fetchQuery({ queryKey: ['sdk', queryName, generation, serializedArgs], queryFn, staleTime: staleTimes[queryName] ?? DEFAULT_STALE_TIME_MS })` call. The per-name generation defaults to zero and changes only at an explicit post-indexer freshness boundary. The `DEFAULT_STALE_TIME_MS` fall-through is a runtime backstop only — the completeness test keeps the policy table exhaustive, so no shipped query name actually relies on it.

Key properties:

- **One `QueryClient` for everything.** Both SDK instances, the Pyth plugin, and the app-side oracle-adapters proxy all write into the same cache.
- **Args serialized via the SDK's `serializeQueryArgs`** (or per-call `context.getCacheKey`). Non-serializable args throw.
- **`undefined` is rewritten to `null` in / `undefined` out** because vue-query refuses to cache `undefined`.

### Invalidation

`invalidateSdkQueries(queryNames)` walks the QueryClient and invalidates any cache key whose `queryName` matches. SDK rows use `fetchQuery` with no standing observer, so this marks the entry stale rather than kicking off an immediate refetch. With the locked TanStack Query 5.101.4, invalidating a key that is already fetching sets `isInvalidated=true`, but a matching `fetchQuery` **joins that pending promise**. When the old request resolves it writes the pre-invalidation value and clears the invalidated flag, so even a subsequent read can return that result with the transport count still at 1. Invalidation is therefore a stale-boundary for later idle reads, not a cancel/version of in-flight work.

`advanceSdkQueryGeneration(queryNames)` increments the cache-key generation synchronously, then invalidates the preceding entries and notifies the same invalidation listeners. An in-flight request can finish for its original caller and write only to its earlier-generation key; any subsequent SDK read uses the new key and starts or joins post-boundary work instead.

Two execution paths use the whole `INVALIDATE_AFTER_TX` list:

- `features/reviewed-execution/review/post-tx-refresh.ts` — invalidates immediately for terminal reviewed submissions, then advances the generation after confirmed-block subgraph catch-up.
- `composables/cowswap/useCowSwapExecutionCore.ts:cancelOrder` — the permit **hard-cancellation** branch only. That path plans and executes an EVC nonce write to invalidate the permit, which is a real on-chain state change. CoW order submission and settlement do not invalidate, and neither does the `cow-api` soft-cancellation branch.

Both paths source `INVALIDATE_AFTER_TX` from `~/utils/sdk-query-policy`. Post-tx invalidation covers both fast V3 account positions (`queryV3AccountPositions`) and fresh/onchain account-vault discovery (`queryAccountVaults`).

Other callers pass their own narrower name list for an explicit refresh: `composables/useSdkRewards.ts` (user reward rows before a portfolio rebuild), `composables/useEulerLabels.ts` (the five label queries on `loadLabels(true)`), and the lend withdraw page (wallet token balances after a swap output changes). Those narrower invalidations have the same in-flight join caveat. Nothing invalidates on form mount — a form that opens within a row's stale window reads the cached value.

### Post-Tx Portfolio Refresh

Terminal `useReviewedExecution.accept` outcomes immediately invalidate `INVALIDATE_AFTER_TX` and call `triggerPortfolioRefresh()`. When dispatch metadata includes a confirmed block, the post-tx helper waits for the SDK subgraph proxy to index that block, advances the `INVALIDATE_AFTER_TX` query generation, and triggers the portfolio refresh again. The second trigger therefore cannot join SDK queries started by the immediate refresh. The shared `portfolioRefreshCounter` drives these consumers:

- `composables/useFreshAccount.ts` reloads the plan-time account snapshot. It races the fast SDK and fresh SDK account reads; fast can fill an empty ref, but the fresh result always wins for the current load cursor.
- `pages/portfolio.vue` calls `updatePositions({ portfolioSource: 'fresh', preemptPortfolio: true })`. That calls `refreshAllPositions(..., { source: 'fresh', preempt: true })`, so `composables/useEulerAccount.ts` loads the visible portfolio through `getEulerSdkFresh()` for the post-tx refresh. `preempt: true` advances the position race guard and resets the refresh coordinator so preempted fast portfolio reads cannot write stale portfolio data or diagnostics over the fresh result.

Normal portfolio page activation and 60-second polling call `updatePositions()` without options. That leaves `source` undefined, and `useEulerAccount` selects the fast SDK only on an explicit `source === 'fast'` — so routine browsing also reads through `getEulerSdkFresh()`. Post-tx calls differ by passing `preempt: true` and by applying the immediate invalidation or post-indexer query-generation boundary first, not by which SDK instance they use. `'fast'` is opt-in and no current caller passes it.

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

Plan builders call `freshPlanContext()` or receive a preloaded account from `useFreshAccount()` and pass that `account` into the SDK. Simulation and reviewed execution preparation use `getEulerSdkFresh()`. Matching account, slot-hint, plugin-prefetch, and simulation preview cache remains reusable only through context-complete canonical identities; SDK object identity is never an authorization or cache key.

The plan-time `Account` snapshot is what gives planners their entity math: `totalShares` / `totalAssets` for asset↔share conversion, sub-account positions for `getPosition`, controller flags for `isControllerEnabled`.

How fresh that snapshot actually is depends on the path taken:

| Path | Freshness |
|---|---|
| `freshPlanContext()` fetches it | Onchain adapters, but served from the shared `QueryClient` at each row's `FORM_STALE_TIMES` window — `queryAccountVaults` is 1 minute, so a snapshot up to a minute old can be reused. No invalidation happens first. |
| Caller passes `input.account` | The `useFreshAccount()` race-replace snapshot, reloaded on wallet/chain change and on `triggerPortfolioRefresh()`. Its fresh task also calls `getEulerSdkFresh()` and then `fetchAccount()`, so those reads go through the shared `QueryClient` as well — bounded by the trigger cadence *and* the applicable `FORM_STALE_TIMES` windows, not by the cadence alone. (A parallel fast task uses the browsing windows; the fresh result wins whenever it lands.) |
| After a successful reviewed execution | Acceptance immediately marks the `invalidateAfterTx` rows stale. Once the subgraph reaches the confirmed receipt block, the second refresh advances those query generations; subsequent plan-time reads cannot join the pre-catch-up fetch. CoW hard-cancel applies ordinary invalidation only. |

`attachSubAccountSnapshot` re-reads the receiver sub-account before planning, because a stale controller flag makes the planner skip `enableController` and the EVC batch reverts. That re-read goes through the same cache, so it corrects a snapshot carried over from an earlier portfolio load but is itself bounded by the same 1-minute window. A planner that needs a stronger guarantee has to invalidate the relevant rows explicitly.
## Where to Extend

| Adding… | Where |
|---------|-------|
| A new env var the SDK needs | `server/plugins/app-config.ts` (server read + `__APP_CONFIG__`), `nuxt.config.ts` (public runtime config key), `composables/useEnvConfig.ts` (resolution order + interface), then pass it into `buildSdkStaticConfig` |
| A new SDK config field | `buildSdkStaticConfig` in `composables/useEulerSdk.ts` (it folds into the existing cache key automatically) |
| A new stale-time policy for an existing query | One row in `SDK_QUERY_POLICY` (`utils/sdk-query-policy.ts`). Derived exports re-compute automatically. |
| A new plan-critical query | Same row, add a shorter `formStaleTimeMs` (`0` to bypass the plan-time cache entirely) and/or `invalidateAfterTx: true`. |
| A new app-side proxy that SDK calls through | Add a same-origin proxy under `server/api/internal/proxy/...`, point the corresponding SDK config field at it in `buildSdkStaticConfig`. See [server-side caching](./server-side-caching.md) for the shared `external-proxy.ts` helper. |
| A new planner | Add the wrapper in `composables/useEulerTx.ts` using `freshPlanContext()` to get a fresh SDK + `Account` |
