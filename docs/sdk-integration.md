# SDK Integration

This document describes how `@eulerxyz/euler-v2-sdk` is initiated inside Euler Lite, how it is configured, how its query cache is wired into vue-query, and the browsing vs fresh entry points that back UI reads and transaction planning.

## Files at a Glance

| File | Purpose |
|------|---------|
| `composables/useEulerSdk.ts` | SDK factory (`getEulerSdk`, `getEulerSdkForChain`, `getEulerSdkFresh`) with Map-based instance cache |
| `utils/sdk-query-policy.ts` | **Single source of truth** — per-query `staleTimeMs` / `formStaleTimeMs` / `invalidateAfterTx`; derived `STALE_TIMES`, `FORM_STALE_TIMES`, `INVALIDATE_AFTER_TX` |
| `utils/sdk-query-cache.ts` | Runtime: shared `QueryClient`, `buildQuery` wrappers, invalidation, and post-indexer query generations |
| `utils/app-config.ts` | `readAppEnvConfig()` — single parser for `__APP_CONFIG__` keys |
| `composables/useEnvConfig.ts` | Resolves env-derived config (incl. `enableV3Backend`) on server and client |
| `server/plugins/app-config.ts` | Calls `readAppEnvConfig()`, overlays `v3ImagesUrl`, injects `window.__APP_CONFIG__` |
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

### Installing a new SDK release

Use npm 11.20.0, the version pinned in `package.json`, CI and the Docker build.
For local development, select it before installing dependencies:

```bash
npm install --global npm@11.20.0
```

`.npmrc` sets `min-release-age=7`: new dependency resolution requires versions
published at least seven days ago. `@eulerxyz/euler-v2-sdk` is the only package in
`min-release-age-exclude`, so a reviewed SDK release can be installed immediately.
Its dependencies still follow the seven-day policy unless they are already
resolved by the committed lockfile.

```bash
npm install --save-exact "@eulerxyz/euler-v2-sdk@<reviewed-version>"
```

Review and commit the manifest and lockfile diff, including any dependency changes
required by the SDK release. Keep the package-specific exemption instead of using
`--min-release-age=0`, which disables the cooldown for every package resolved by
that command.

`npm ci` installs the committed lockfile without choosing newer versions; it does
not prove that the locked versions satisfy the release-age policy. Dependabot
keeps its separate seven-day `cooldown` in `.github/dependabot.yml`.

## SDK Entry Points

The app exposes three SDK entry points, all produced by the same factory in `composables/useEulerSdk.ts`:

- **`getEulerSdk()` — default browsing instance.** Adapter chain is picked by `NUXT_PUBLIC_BROWSER_VAULT_SOURCE` (default `fallback`):
  - `fallback` — V3 primary → onchain secondary. When `enableV3Backend` is false the SDK is built with `disableV3: true` so the chain short-circuits to onchain.
  - `onchain` — account/vault/Earn reads use on-chain / subgraph adapters. Optional V3 utilities remain available unless `DISABLE_V3` is enabled.
  - `v3` — V3 only; SDK build throws if no V3 endpoint is configured.

  Cache wrapper is `sdkBuildQuery`, which applies `STALE_TIMES` (the per-query stale times from `SDK_QUERY_POLICY`). UI surfaces — vault lists, portfolio display, prices, rewards — consume this instance.

- **`getEulerSdkForChain(chainId)` — chain-aware browsing instance.** Chains listed in `ONCHAIN_SDK_CHAINS` use the onchain backend regardless of `NUXT_PUBLIC_BROWSER_VAULT_SOURCE`; all other chains use the default browsing backend. This keeps the browsing cache policy while avoiding V3-backed account/vault/Earn adapters for the pinned chains (typically deprecated chains whose V3 data is gone). Surfaces with an explicit chain id use this entry point.

- **`getEulerSdkFresh()` — form-time / plan-time instance.** Account and vault adapters are pinned to on-chain / subgraph reads regardless of `NUXT_PUBLIC_BROWSER_VAULT_SOURCE` or `enableV3Backend`; rewards use fallback so V3 reward rows can be paired with direct provider proof data. Cache wrapper is `sdkFreshBuildQuery`, which applies `FORM_STALE_TIMES` — pre-resolved `formStaleTimeMs ?? staleTimeMs` per row. Plan-critical account and vault reads use shorter form-time windows than browsing reads: for example, `queryEVaultInfoFull` uses 1 minute and balance-like migration reads use 15 seconds. Checked subgraph account discovery uses a 1-minute form window; factory lookup retains its 5-minute window. Catalogue / labels / prices fall through to the configured stale-time value and continue to hit the shared cache. `composables/useEulerTx.ts` consumes this instance through a small `freshPlanContext()` helper which also fetches an `Account` through those onchain adapters.

  Pinning the adapters changes the *data source*, not the cache. `sdkFreshBuildQuery` still runs through the shared `QueryClient`, and `freshPlanContext()` does not invalidate before fetching, so a plan-time `Account` uses cached RPC/V3 values according to their `FORM_STALE_TIMES` windows. Subgraph discovery and factory payloads are checked on cache misses; cached reads follow the same stale-time and invalidation policy. Immediate reviewed-execution invalidation (`invalidateAfterTx`) marks those rows stale so a later idle read re-fetches after the user's own state changes; the fresh instance alone does not. Ordinary invalidation joins an in-flight `fetchQuery` for the same key. The post-indexer portfolio refresh uses a new query generation, so reads triggered after the subgraph reaches the confirmed block cannot join the pre-catch-up request. Neither entry point by itself guarantees a latest-block read.

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
3. Calls `buildEulerSDK({ config, buildQuery, plugins: [createPythPlugin(...), createKeyringPlugin(...), createLiteTosPlugin()], servicesOverrides: { intrinsicApyService, eulerLabelsService } })`. The intrinsic APY override wraps V3 data with Lite rows from `/api/internal/proxy/intrinsic-apy-overrides` — see [Intrinsic APY](./intrinsic-apy.md#lite-override-proxy). The labels override reads `/api/internal/public-labels`, which selects V3 or a configured fork's static labels on the server. SDK label population therefore uses Lite's selected source. The server snapshot SDK does not install the intrinsic APY wrapper.
4. Wires app-side proxy callbacks via `configureAppProxies` for SDK services that do not natively use the shared V3 base, currently the ABI service. Oracle assessment and router queries use the SDK's native V3 methods and `/api/internal/v3/...` allowlist.

If `buildEulerSDK` rejects, the map entry is cleared so the next caller retries instead of being stuck on a poisoned promise.

## Configuration

There are two layers of configuration: env vars (resolved by `useEnvConfig`) and runtime URLs (read directly from `useRuntimeConfig().public` inside `useEulerSdk`).

### `useEnvConfig`

`composables/useEnvConfig.ts` resolves config in this order (first non-empty wins). The env keys themselves are parsed once in `readAppEnvConfig()` (`utils/app-config.ts`); the plugin injects that object and the composable does not re-scan `process.env` on the client:

1. `window.__APP_CONFIG__` — injected at runtime by `server/plugins/app-config.ts` from `readAppEnvConfig()` plus `v3ImagesUrl`. Supports Doppler-injected env vars that change without a rebuild.
2. `useRuntimeConfig().public` — build-time values from `NUXT_PUBLIC_*` env vars (used by static / CDN deployments where the Nitro render hook never fires).
3. Hard-coded `DEFAULTS`.

On the server, `useEnvConfig()` calls `readAppEnvConfig()` directly.

The runtime config fields include:

- **`enableV3Backend: boolean`** — true when a V3 URL is configured and `DISABLE_V3` is false, emitted via `window.__APP_CONFIG__`. The client falls back to the public runtime configuration for static deploys. When `false` *and* `browserVaultSource === 'fallback'`, the SDK is built with `disableV3: true`.
- **`disableV3: boolean`** — the explicit opt-out, applied to every SDK instance and V3 utility independently of the selected vault data source.
- **`browserVaultSource: 'fallback' | 'onchain' | 'v3'`** — pinned by `NUXT_PUBLIC_BROWSER_VAULT_SOURCE` (default `fallback`). Selects which adapter block (`fallbackAdapterConfig` / `onchainAdapterConfig` / `v3AdapterConfig`) the fast SDK uses. The plan-time SDK ignores this — it's always `onchain`.
- **`eulerInterfacesBranch: string`** — pinned by `EULER_SDK_EULER_INTERFACES_BRANCH` (default `master`). `/api/internal/euler-chains` and `/api/internal/abis` resolve their upstreams from the same branch. Explicit URL overrides (`NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL`, `NUXT_PUBLIC_CONFIG_EULER_ABIS_BASE_URL`) take precedence over the branch — they are the emergency repoint levers when the default GitHub source is unavailable.

Chain-aware browsing calls also read `useChainConfig().onchainSdkChainIds`, injected from `ONCHAIN_SDK_CHAINS`. Listed chains use the onchain backend; all other chains use `browserVaultSource`. This setting is independent of the `deprecated` status in `EulerChains.json` and the optional `DEPRECATED_CHAINS` override. Deprecated status controls chain-selector collapsing, warm-cache skipping, and the metadata-only labels adapter; the onchain SDK list controls vault and account data routing.

`DISABLE_V3=true` explicitly disables V3 across Lite's server and browser SDKs, proxy, image discovery and optional utilities. Lite removes the pricing backend while preserving on-chain prices, disables the SDK token-list HTTP query while preserving RPC decimal resolution, and supplies an unavailable intrinsic-APY source. It requires static labels. This is separate from selecting on-chain vault/account reads; see [Fork setup](./fork-setup.md) for supported combinations and the standalone SDK settings.

The same list also gates the direct (non-SDK) V3 fetches via `composables/useV3ChainGate.ts`: collateral open interest / exposure (`useCollateralOpenInterest`), bad debt (`useVaultBadDebt`), and vault history charts (`VaultOverviewBlockHistory.vue`). `isV3EnabledForChain(chainId)` requires `enableV3Backend` *and* the chain not being in `ONCHAIN_SDK_CHAINS`. This mirrors only the per-chain `ONCHAIN_SDK_CHAINS` override; a global `NUXT_PUBLIC_BROWSER_VAULT_SOURCE=onchain` pin is intentionally not gated, since the V3-only endpoints have no on-chain equivalent to fall back to. Bad debt and history sections hide when gated (V3-only data, no RPC equivalent). Exposure instead degrades to an RPC-derived fallback. Every exposure surface (lend/borrow cards, vault overview, earn surfaces, discovery matrix) routes its state through the shared `resolveVaultExposureDisplay` (in `utils/vault/exposure-display.ts`), which picks the live allocated split when open interest is available and otherwise `buildFallbackVaultExposureDisplay`: vaults where the split is fully determined without open-interest data (nothing utilized, or a vault that accepts a single collateral) show exact values; anything else — including a multi-collateral vault that collapses to one live group because another collateral is missing or ramped out — shows the qualitative backing-asset list rather than misattributing the full amount, with the hover breakdown listing the assets without a value column and a single "USD breakdown unavailable" note. When the split is known (live open interest, or an exact RPC fallback), only collaterals with actual current exposure are listed — accepted collaterals currently backing no borrows are omitted rather than shown as $0 rows, and a vault with nothing utilized collapses to an empty "-". When the split is unknown, the qualitative fallback still lists every accepted collateral (values hidden) so the user sees what the vault *can* be exposed to. Idle (un-utilized) supply is never shown as exposure. Earn strategy headers use `getVaultBackingLead`: while the vault has utilization the lead is **Backed by** the current-exposure assets; when utilization is zero the lead is **Accepts** and lists only collaterals with `maxBorrowLTV > 0` (collateral that cannot back a new borrow is omitted). (The separate "Collateral exposure" overview/modal section is a configured-collateral list and still shows every collateral with its LTVs and per-collateral current exposure, including $0.) The same fallback covers V3 fetch errors and utilized vaults the indexer returns no rows for, so a lagging indexer degrades the display instead of blanking it.

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
| `rewardsMerklApiUrl` | `/api/internal/proxy/merkl` | Merkl proxy |
| `rewardsFuulApiUrl` | `/api/internal/proxy/fuul` | Fuul proxy |
| `rewardsBrevisApiUrl` | `/api/internal/proxy/incentra/sdk/v1/eulerCampaigns` | Incentra/Brevis proxy |
| `rewardsBrevisProofsApiUrl` | `/api/internal/proxy/incentra/v1/getMerkleProofsBatch` | Incentra/Brevis proxy |
| `rewardsTurtleApiUrl` | `/api/internal/proxy/turtle` | Turtle Earn proxy; only reward proofs pass its allowlist, so the browser fetches proofs here while stream discovery runs in the server-side SDK (see below) |
| `accountVaultsSubgraphUrls[chainId]` | `/api/internal/proxy/subgraph/{chainId}` | Configured subgraph proxy |
| `vaultTypeSubgraphUrls[chainId]` | `/api/internal/proxy/subgraph/{chainId}` | Configured subgraph proxy |
| `rpcUrls[chainId]` | `/api/internal/rpc/{chainId}` | JSON-RPC proxy |
| Adapter block | `fallbackAdapterConfig` / `onchainAdapterConfig` / `v3AdapterConfig` per `browserVaultSource` (default browsing), `onchainAdapterConfig` (`ONCHAIN_SDK_CHAINS` browsing and plan-time) | — |
| `disableV3` | Explicit `DISABLE_V3`, or a resolved `fallback` source with `!enableV3Backend` | — |

Reward provider toggles (`rewardsEnableMerkl`, `rewardsEnableBrevis`, `rewardsEnableFuul`, `rewardsEnableTurtle`) are emitted as `false` only when `useDeployConfig()` disables them.

The server-side SDK (`server/utils/sdk-server.ts`) differs for Turtle: its rewards adapters call `earn.turtle.xyz` directly, so it receives the server-only `TURTLE_EARN_API_KEY` as `rewardsTurtleApiKey` pinned to the fixed Turtle upstream, and is built with `rewardsEnableTurtle: false` when no usable key is configured. That flag disables the direct adapter's Turtle discovery only; Turtle campaigns sourced from euler-data-v3 may still be returned in fallback mode. The key never enters the browser config. The same builder passes Sonic (`146`) transport tuning to the SDK so it uses a smaller Multicall aggregate while preserving registry `viemName` resolution; other chains keep the SDK transport defaults. See [server-side caching](./server-side-caching.md#server-side-sdk-builder) and [server provider overrides](./server-side-caching.md#server-provider-overrides).

The server snapshot and token-list SDKs use `server/utils/sdk-abi-service.ts` to read ABIs through the same validated `loadAbi` cache as the browser proxy. `NUXT_PUBLIC_CONFIG_EULER_ABIS_BASE_URL` takes precedence over `EULER_SDK_EULER_INTERFACES_BRANCH` and its `NUXT_PUBLIC_EULER_INTERFACES_BRANCH` / `NUXT_PUBLIC_CONFIG_EULER_INTERFACES_BRANCH` aliases. All three paths accept only `AccountLens`, `VaultLens`, and `UtilsLens`, with the shared five-minute freshness and bounded seven-day stale fallback.

### Reward token decimals

`UserRewardToken.decimals` is optional. The SDK omits it when no source — the
breakdown row, the campaign entry in `/v3/apys/rewards`, or the per-row
`rewardTokenMetadata` the V3 backend resolves independently of campaign
availability — could resolve the token; it no longer falls back to 18, which
used to mis-scale every reward token that is not 18 decimals (a USDC reward of
603375 raw units read as ~6.03e-13 instead of 0.603375).

`entities/reward-campaign.ts` owns the scaling: `rewardUnclaimedAmount()` and
`rewardUnclaimedUsdValue()` return `undefined` for an unresolved token rather
than guessing. `PortfolioSdkRewardItem.vue` then shows "Amount unavailable"
with an em dash in place of the USD value, and disables both Claim and Add to batch, because
signing a claim whose amount cannot be stated is worse than not offering it.
The raw balance and proof are untouched, so the row becomes claimable again as
soon as the token resolves upstream. Unresolved rows sort last in
`pages/portfolio/rewards.vue` instead of being treated as worth zero.

Claiming freezes the clicked reward first. `rewardClaimSnapshot()` in
`features/reviewed-execution/domain/rewards.ts` returns the reward together with
the decimals and amount the review will state, or `undefined` when the token is
unresolved. The claim then awaits a wallet network switch, during which the
portfolio list can refresh and replace the row, so everything after that await —
the intent, the plan and the review payload — is built from the snapshot, and
`hasRewardDrifted()` aborts with a toast when the live row no longer matches it.
Without that guard the review can show one reward's amount beside another
reward's claim intent.

`rewardClaimId` distinguishes Incentra/Brevis epochs (`provider === 'brevis'`)
that share a campaign, token, and unclaimed amount. Other providers ignore
`epoch` so a leftover field cannot split or collide their claims. Details:
[Transaction Building → Reward claim identity](./transaction-building.md#reward-claim-identity).

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
  queryPublicLabels: { staleTimeMs: 5 * SECOND },
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

The checked subgraph leaf queries `queryAccountVaults` and `queryVaultFactories` use these result-cache windows with source-scoped keys; their transport checks are described [below](#subgraph-catalog-resolution).

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

- **One `QueryClient` for everything.** Both SDK instances and the Pyth plugin write into the same cache, including native oracle assessment and router queries.
- **Args serialized via the SDK's `serializeQueryArgs`** (or per-call `context.getCacheKey`). Non-serializable args throw.
- **`undefined` is rewritten to `null` in / `undefined` out** because vue-query refuses to cache `undefined`.

### Invalidation

`invalidateSdkQueries(queryNames)` walks the QueryClient and invalidates any cache key whose `queryName` matches. SDK rows use `fetchQuery` with no standing observer, so this marks the entry stale rather than kicking off an immediate refetch. With the locked TanStack Query 5.101.4, invalidating a key that is already fetching sets `isInvalidated=true`, but a matching `fetchQuery` **joins that pending promise**. When the old request resolves it writes the pre-invalidation value and clears the invalidated flag, so even a subsequent read can return that result with the transport count still at 1. Invalidation is therefore a stale-boundary for later idle reads, not a cancel/version of in-flight work.

`advanceSdkQueryGeneration(queryNames)` increments the cache-key generation synchronously, then invalidates the preceding entries and notifies the same invalidation listeners. An in-flight request can finish for its original caller and write only to its earlier-generation key; any subsequent SDK read uses the new key and starts or joins post-boundary work instead.

Two execution paths use the whole `INVALIDATE_AFTER_TX` list:

- `features/reviewed-execution/review/post-tx-refresh.ts` — invalidates immediately for terminal reviewed submissions, then advances the generation after confirmed-block subgraph catch-up.
- `composables/cowswap/useCowSwapExecutionCore.ts:cancelOrder` — the permit **hard-cancellation** branch only. That path plans and executes an EVC nonce write to invalidate the permit, which is a real on-chain state change. CoW order submission and settlement do not invalidate, and neither does the `cow-api` soft-cancellation branch.

Both paths source `INVALIDATE_AFTER_TX` from `~/utils/sdk-query-policy`. Post-tx invalidation covers both fast V3 account positions (`queryV3AccountPositions`) and fresh/onchain account-vault discovery (`queryAccountVaults`).

Other callers pass their own narrower name list for an explicit refresh: `composables/useSdkRewards.ts` (user reward rows before a portfolio rebuild) and the lend withdraw page (wallet token balances after a swap output changes). Those narrower invalidations have the same in-flight join caveat. Nothing invalidates on form mount — a form that opens within a row's stale window reads the cached value.

Lite's injected labels service uses the application-owned bundle and freshness policy. `useEulerLabels.loadLabels(true)` requests `/api/internal/public-labels` with `cache-control: no-cache`; it does not invalidate SDK label queries. The SDK's built-in `queryPublicLabels` has a five-second policy for instances that use that adapter.

### Post-Tx Portfolio Refresh

Terminal `useReviewedExecution.accept` outcomes immediately invalidate `INVALIDATE_AFTER_TX` and call `triggerPortfolioRefresh()`. When dispatch metadata includes a confirmed block, the post-tx helper polls the SDK subgraph proxy in the background within a bounded catch-up budget. If the subgraph reaches that block, the helper advances the `INVALIDATE_AFTER_TX` query generation and triggers the portfolio refresh again. The second trigger therefore cannot join SDK queries started by the immediate refresh. A catch-up timeout logs a warning; ordinary discovery reads and planning account fallbacks remain available. The shared `portfolioRefreshCounter` drives these consumers:

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
| `freshPlanContext()` fetches it | Onchain adapters with checked subgraph discovery cached for up to 1 minute. RPC reads use the shared `QueryClient` at each row's `FORM_STALE_TIMES` window; for example, `queryEVaultInfoFull` can reuse a value up to 1 minute old. No invalidation happens first. |
| Caller passes `input.account` | The `useFreshAccount()` race-replace snapshot, reloaded on wallet/chain change and on `triggerPortfolioRefresh()`. Its fresh task also calls `getEulerSdkFresh()` and then `fetchAccount()`, so subgraph discovery and RPC reads are bounded by the trigger cadence *and* the applicable `FORM_STALE_TIMES` windows, not by the cadence alone. (A parallel fast task uses the browsing windows; the fresh result wins whenever it lands.) |
| After a successful reviewed execution | Acceptance immediately marks the `invalidateAfterTx` rows stale. Once the subgraph reaches the confirmed receipt block, the second refresh advances those query generations; subsequent plan-time reads cannot join the pre-catch-up fetch. CoW hard-cancel applies ordinary invalidation only. |

`attachSubAccountSnapshot` re-reads the receiver sub-account before planning, because a stale controller flag makes the planner skip `enableController` and the EVC batch reverts. That re-read goes through the same cache, so it corrects a snapshot carried over from an earlier portfolio load but is itself bounded by the same 1-minute window. A planner that needs a stronger guarantee has to invalidate the relevant rows explicitly.
## Where to Extend

| Adding… | Where |
|---------|-------|
| A new env var the SDK needs | `utils/app-config.ts` (`readAppEnvConfig` + `AppEnvConfig`), `nuxt.config.ts` (public runtime config key), `composables/useEnvConfig.ts` (`fromRuntimeConfig` fallback), then pass it into `buildSdkStaticConfig`. Do not re-parse the env key in `server/plugins/app-config.ts`. |
| A new SDK config field | `buildSdkStaticConfig` in `composables/useEulerSdk.ts` (it folds into the existing cache key automatically) |
| A new stale-time policy for an existing query | One row in `SDK_QUERY_POLICY` (`utils/sdk-query-policy.ts`). Derived exports re-compute automatically. |
| A new plan-critical query | Same row, add a shorter `formStaleTimeMs` (`0` to bypass the plan-time cache entirely) and/or `invalidateAfterTx: true`. |
| A new app-side proxy that SDK calls through | Add a same-origin proxy under `server/api/internal/proxy/...`, point the corresponding SDK config field at it in `buildSdkStaticConfig`. Build it with `createProviderProxy` — the pipeline, rules and checklist are in [Server-Side Caching → Adding a provider](./server-side-caching.md#adding-a-provider). |
| A new planner | Add the wrapper in `composables/useEulerTx.ts` using `freshPlanContext()` to get a fresh SDK + `Account` |


## Subgraph catalog resolution

Direct per-chain URLs work without a catalog. For copyable fork configurations, see [Your own subgraphs](./fork-setup.md#your-own-subgraphs), including direct-only resolution without bundled Euler subgraph fallback and an optional custom catalog.

`SUBGRAPH_CATALOG_URL` opts into a server-only v1 catalog. Leave it empty for
URL-only proxy configuration. Euler's official catalog is published at
`https://raw.githubusercontent.com/euler-xyz/euler-subgraph/catalog/v1/catalog.json`.
`.env.example` explicitly sets `SUBGRAPH_CATALOG_URL` to this URL and leaves
per-chain URLs unset. The runtime has no implicit catalog URL. Forks can replace
it with their own catalog or use the direct-only configuration linked above.

Resolution is per chain: `SUBGRAPH_DISABLED_<chainId>=true` disables subgraph
reads; otherwise `SUBGRAPH_URL_<chainId>`, then `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>`,
then the catalog default wins. Empty values mean unset. `SUBGRAPH_CATALOG_DISABLED=true`
disables catalog defaults **and bundled server SDK subgraph fallback**, while retaining explicit URLs. A blank catalog URL alone does not suppress the server SDK's bundled compatibility mode. Private HTTP endpoints
and authenticated/custom URL overrides remain operator-controlled; catalog rows
require credential-free HTTPS URLs without query strings/fragments. Redirects are
rejected. The browser only receives same-origin proxy URLs and an opaque source
identity, never configured upstream credentials.

The resolver selects stable `euler-simple` records with both
`account-vault-discovery` and `vault-factory-lookup`. Candidate/other-family rows
are ignored. Duplicate or invalid selected identities are quarantined per chain.
Retirement is authoritative; no bundled endpoint is resurrected. Missing sources
return HTTP 404; disabled, retired, malformed, unsupported-capability, or unavailable
catalog sources return HTTP 503 with a reason. Upstream and deployment-identity
failures return HTTP 502. These failures are not successful empty discovery.

Catalog records for existing deployments may omit `sourceCommit`, `startBlock` and `interfacesCommit` when build provenance is unverified. Supplied values must be valid. Endpoint, deployment ID, version and required capabilities remain mandatory; response identity checks apply to every selected catalog source. The SDK owns catalog parsing, metadata caching and discovery queries. Lite configures `createSubgraphCatalogResolver` and `withSubgraphQueries` with its environment priority, proxy transport and cache policy. Its installed SDK must support these APIs and optional build provenance.

Catalog metadata is fresh for 60 seconds. A failed refresh can reuse the last
successful snapshot for at most seven days from that success (`MANIFEST_MAX_STALE_MS`); retries are
single-flight with a ten-second failure backoff. Failures never extend that age.
A successful retirement or omission replaces active metadata immediately. The cache is
in memory per server process and scoped to its catalog URL; a cold start has no
last-good snapshot. Proxy responses remain `no-store` and are only deduplicated
while in flight. SDK result caching is separate from the proxy cache.

Browser SDK subgraph queries use checked transport through the existing proxy.
Server snapshot/labels SDK subgraph queries use the same resolver directly,
without self-HTTP. Before catalog opt-in, server SDK reads without explicit URLs
retain the published SDK's bundled defaults; `SUBGRAPH_CATALOG_DISABLED=true` or
`SUBGRAPH_DISABLED_<chainId>=true` prevents this compatibility fallback. An opted-in catalog's missing/retired/invalid records never
fall back. The browser proxy retains its missing-URL 404 behavior. V3 remains the configured primary where applicable. Both
paths validate HTTP/GraphQL payloads and the actual response's `_meta.deployment`
against a catalog deployment ID. Lite configures the SDK’s `withSubgraphQueries` at its `buildQuery` boundary for the two subgraph leaf
queries (`queryAccountVaults`, `queryVaultFactories`). The SDK owns GraphQL construction, pagination, response validation and source consistency; Lite supplies only transport and opaque proxy identity hooks. Other queries retain their
existing caching policy. Checked leaf queries use the supplied cache builder: the
browser shares 5-minute browsing windows, a 1-minute account form window, and
transaction invalidation/generation handling. Server SDK leaf results use the
SDK's default 5-second cache. Keys include the chain, endpoint, source identity and deployment ID when available,
and the SDK's original query key; a null SDK key opts out of caching.
Server leaf reads resolve current metadata before cache lookup, so retirement rejects
and a different selected source cannot reuse prior results. Browser cache hits
need no proxy request: changes behind the proxy are checked on the next miss,
expiry or invalidation, within the applicable window. Every fetched response is
validated and a paginated lookup rejects a source/deployment change between pages.

After a confirmed transaction, the browser refreshes immediately and polls the
subgraph in the background for an additional refresh. Discovery accepts valid
responses at the selected provider's current indexed height, including while
catch-up is pending or after it times out. Catch-up success advances query
generations to refresh RPC/V3 values; portfolio generation guards discard
preempted reads. These refreshes are best-effort and do not guarantee the latest
chain state. HTTP/GraphQL errors, malformed data and deployment identity
mismatches still fail validation. Successful empty arrays are accepted only
after response checks.

Catalog membership does not enable RPC chains, change Interfaces lifecycle or
production staging filtering, or replace `ONCHAIN_SDK_CHAINS`, V3, custom/static
labels, ABI overrides, or deployment services. Publication/deployment remains a
separate operator action.
