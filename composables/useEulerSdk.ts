import { buildEulerSDK, createKeyringPlugin, createPythPlugin, IntrinsicApyService, IntrinsicApyV3Adapter } from '@eulerxyz/euler-v2-sdk'
import type { BuildQueryFn, EulerSDK, EulerSDKConfig } from '@eulerxyz/euler-v2-sdk'
import { INTERNAL_API_BASE } from '~/utils/api-url-env'
import { sdkBuildQuery, sdkFreshBuildQuery } from '~/utils/sdk-query-cache'
import { createLiteTosPlugin } from '~/utils/sdk-tos'
import { createYuzuIntrinsicApyService } from '~/utils/yuzu-intrinsic-apy'

// sdk-keyring is loaded dynamically below to avoid a static import cycle:
// useEulerSdk -> sdk-keyring -> eulerLabelsUtils -> useEulerLabels ->
// useEulerOracleAdapters -> useEulerSdk. The keyring helpers are only used
// inside async setup paths, so deferring the import has no runtime impact.
type SdkKeyringModule = typeof import('~/utils/sdk-keyring')
let sdkKeyringModulePromise: Promise<SdkKeyringModule> | undefined
const loadSdkKeyringModule = (): Promise<SdkKeyringModule> => {
  sdkKeyringModulePromise ??= import('~/utils/sdk-keyring')
  return sdkKeyringModulePromise
}

type QueryOracleAdapters = (chainId: number) => Promise<unknown>
type ConfigurableOracleAdapterService = EulerSDK['oracleAdapterService'] & {
  setQueryOracleAdapters?: (fn: QueryOracleAdapters) => void
}

// Browser CSP blocks hermes.pyth.network. The SDK's Pyth plugin issues
// `GET <hermesUrl>/v2/updates/price/latest?ids[]=…` — rewrite that request to
// our same-origin proxy at `/api/internal/pyth/updates`, which forwards to Hermes
// server-side. Non-Pyth/non-browser callers fall through to the native fetch.
const pythProxyFetch: typeof fetch = (input, init) => {
  if (typeof window === 'undefined') return fetch(input, init)
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
  if (url && /\/v2\/updates\/price\/latest(\?|$)/.test(url)) {
    const incoming = new URL(url, window.location.origin)
    const proxied = new URL('/api/internal/pyth/updates', window.location.origin)
    incoming.searchParams.forEach((v, k) => proxied.searchParams.append(k, v))
    return fetch(proxied.toString(), init)
  }
  return fetch(input, init)
}

/**
 * Three SDK entry points are exposed:
 *
 *   - `getEulerSdk()`  — "fast" / browsing instance. Adapter chain is picked
 *     by `NUXT_PUBLIC_BROWSER_VAULT_SOURCE` (default `fallback`):
 *       • `fallback` — V3 HTTP primary, on-chain secondary; auto-degrades to
 *         onchain via `disableV3: true` when no V3 endpoint is configured.
 *       • `onchain`  — direct on-chain reads only; never touches V3.
 *       • `v3`       — V3 only; SDK build throws without a V3 endpoint.
 *     Uses the default `sdkBuildQuery` cache policy (sub-minute stale times
 *     for hot reads, longer for catalogue data). Consumed by UI surfaces:
 *     vault lists, portfolio display, prices, rewards.
 *
 *   - `getEulerSdkForChain(chainId)` — same browsing cache policy as
 *     `getEulerSdk()`, but chains listed in `ONCHAIN_SDK_CHAINS` are routed to
 *     the onchain adapter config so their fast reads do not use V3-backed
 *     account/vault/Earn adapters.
 *
 *   - `getEulerSdkFresh()`  — "slow" / plan-time instance. Account and vault
 *     adapters are pinned to on-chain/subgraph reads regardless of the browser
 *     source, so transaction planning reflects the latest block. Rewards use
 *     fallback so V3 reward rows can be paired with direct claim-proof data.
 *     Uses `sdkFreshBuildQuery`, which forces a zero stale time on plan-critical
 *     queries (account, vault info, balances, allowances, pyth update data)
 *     while letting catalogue / labels / prices fall through to the same
 *     QueryClient cache that the fast instance fills. The fresh instance's
 *     refetches write back to the shared cache, so a subsequent fast read sees
 *     the just-refreshed value within its own staleness window. Consumed by
 *     `useEulerTx` planners and simulate/execute.
 */

type SdkInstance = { sdk: EulerSDK }

const instances = new Map<string, Promise<SdkInstance>>()

const getPublicRuntimeConfig = (): Record<string, string> => {
  if (typeof useRuntimeConfig !== 'function') return {}
  return useRuntimeConfig().public as unknown as Record<string, string>
}

const cleanUrl = (value: string | undefined) => {
  const trimmed = value?.trim().replace(/\/+$/, '')
  return trimmed || undefined
}

const buildAppApiPath = (path: string) => {
  const requestUrl = import.meta.server && typeof useRequestURL === 'function'
    ? useRequestURL()
    : undefined
  return `${requestUrl?.origin ?? ''}${path}`
}

// The SDK appends `/v3/...` paths, so the same-origin base is `/api/internal`.
const buildV3ProxyApiPath = () => buildAppApiPath(INTERNAL_API_BASE)
// Per-host proxies wrap the SDK's direct upstream calls so they (1) share
// one server-side TTL cache across browser tabs, (2) take the cold-TLS
// hit once at proxy startup rather than on every user, and (3) keep
// upstream URLs (and any auth) server-only. See
// `server/api/internal/proxy/{merkl,fuul,incentra,subgraph}/[...path].ts` and
// `server/api/internal/labels/[chainId]/[file].get.ts`.
const buildMerklProxyApiPath = () => buildAppApiPath('/api/internal/proxy/merkl')
const buildFuulProxyApiPath = (path = '') =>
  buildAppApiPath(`/api/internal/proxy/fuul${path ? `/${path.replace(/^\/+/, '')}` : ''}`)
const buildIncentraProxyApiPath = (path: string) =>
  buildAppApiPath(`/api/internal/proxy/incentra/${path.replace(/^\/+/, '')}`)
const buildTurtleProxyApiPath = () => buildAppApiPath('/api/internal/proxy/turtle')
// Exported so post-tx subgraph polling (useEulerTx) hits the exact same
// endpoint the SDK's account/vault-type adapters read through. Polling the
// upstream Goldsky URL directly would measure a different indexer head than
// the one actually serving queryAccountVaults.
export const buildSubgraphProxyApiPath = (chainId: number) =>
  buildAppApiPath(`/api/internal/proxy/subgraph/${chainId}`)
const buildLabelsProxyApiPath = () => buildAppApiPath('/api/internal/labels')
const buildMorphoProxyApiPath = () => buildAppApiPath('/api/internal/proxy/morpho')
const buildAaveProxyApiPath = () => buildAppApiPath('/api/internal/proxy/aave')

type SdkBackend = 'fast' | 'onchain'

const fallbackAdapterConfig: Partial<EulerSDKConfig> = {
  accountServiceAdapter: 'fallback',
  eVaultServiceAdapter: 'fallback',
  eulerEarnServiceAdapter: 'fallback',
  vaultTypeAdapter: 'fallback',
  rewardsServiceAdapter: 'fallback',
}

const v3AdapterConfig: Partial<EulerSDKConfig> = {
  accountServiceAdapter: 'v3',
  eVaultServiceAdapter: 'v3',
  eulerEarnServiceAdapter: 'v3',
  vaultTypeAdapter: 'v3',
  rewardsServiceAdapter: 'v3',
}

const onchainAdapterConfig: Partial<EulerSDKConfig> = {
  accountServiceAdapter: 'onchain',
  eVaultServiceAdapter: 'onchain',
  eulerEarnServiceAdapter: 'onchain',
  vaultTypeAdapter: 'subgraph',
  rewardsServiceAdapter: 'fallback',
}

// Per-chain subgraph URL map → server proxy. The proxy resolves the real
// upstream from env (`SUBGRAPH_URL_<chainId>` or
// `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>`). We register every enabled chain
// up-front so the SDK's subgraph adapters never see a direct Goldsky URL.
const buildSubgraphUrlMap = (): Record<number, string> => {
  const { allowedChainIds } = useEulerAddresses()
  const out: Record<number, string> = {}
  for (const chainId of allowedChainIds.value) {
    out[chainId] = buildSubgraphProxyApiPath(chainId)
  }
  return out
}

const adapterConfigForFastSource = (source: 'fallback' | 'onchain' | 'v3'): Partial<EulerSDKConfig> => {
  switch (source) {
    case 'onchain': return onchainAdapterConfig
    case 'v3': return v3AdapterConfig
    default: return fallbackAdapterConfig
  }
}

const buildSdkStaticConfig = (backend: SdkBackend) => {
  const rc = getPublicRuntimeConfig()
  const { enableMerkl, enableIncentra, enableFuul, enableTurtle } = useDeployConfig()
  const oracleChecksBaseUrl = cleanUrl(rc.configOracleChecksBaseUrl)
  const swapApiUrl = cleanUrl(rc.swapApiUrl)
  const v3ApiUrl = buildV3ProxyApiPath()
  const labelsProxyUrl = buildLabelsProxyApiPath()
  const subgraphUrls = buildSubgraphUrlMap()
  const { enableV3Backend, browserVaultSource, eulerInterfacesBranch } = useEnvConfig()
  // 'fast' resolves to whatever NUXT_PUBLIC_BROWSER_VAULT_SOURCE pins.
  // 'onchain' covers both ONCHAIN_SDK_CHAINS fast reads and the plan-time
  // instance, which exists specifically so the planner sees fresh chain
  // state, not V3-cached data, even when fast reads can tolerate stale.
  const fastSource = backend === 'fast' ? browserVaultSource : 'onchain'
  const config: EulerSDKConfig = {
    // The proxy path is wired regardless of `backend` so that the SDK can still
    // resolve v3-only utility endpoints (tokenlist) when adapters that fall
    // back to v3 internally are encountered. The per-service adapter flags are
    // what actually steer reads through the fallback chain vs straight onchain.
    ...(v3ApiUrl ? { v3ApiUrl, tokenlistApiBaseUrl: v3ApiUrl, intrinsicApyV3ApiUrl: v3ApiUrl } : {}),
    eulerInterfacesBranch,
    deploymentsUrl: buildAppApiPath('/api/internal/euler-chains'),
    // Labels always go through the local /api/internal/labels proxy. Server-side env
    // (`NUXT_PUBLIC_CONFIG_LABELS_BASE_URL`/`*_REPO`) controls where the proxy
    // fetches upstream, so callers see a single internal hostname. Same
    // pattern as `tokenlistApiBaseUrl` above.
    eulerLabelsBaseUrl: labelsProxyUrl,
    ...(oracleChecksBaseUrl ? { oracleAdaptersBaseUrl: oracleChecksBaseUrl } : {}),
    ...(swapApiUrl ? { swapApiUrl } : {}),
    ...(enableMerkl ? { rewardsMerklApiUrl: buildMerklProxyApiPath() } : { rewardsEnableMerkl: false }),
    // Incentra/Brevis: SDK takes the full URL for each endpoint, so map both
    // to the corresponding paths under our incentra proxy.
    ...(enableIncentra
      ? {
          rewardsBrevisApiUrl: buildIncentraProxyApiPath('sdk/v1/eulerCampaigns'),
          rewardsBrevisProofsApiUrl: buildIncentraProxyApiPath('v1/getMerkleProofsBatch'),
        }
      : { rewardsEnableBrevis: false }),
    // Fuul: SDK appends `/incentives?...` and `/claimable-rewards?...` to the
    // base URL. The proxy keeps these reward reads same-origin and cached.
    ...(enableFuul
      ? {
          rewardsFuulApiUrl: buildFuulProxyApiPath(),
        }
      : { rewardsEnableFuul: false }),
    ...(enableTurtle
      ? {
          rewardsTurtleApiUrl: buildTurtleProxyApiPath(),
        }
      : { rewardsEnableTurtle: false }),
    // Goldsky subgraph: route every chain through `/api/internal/proxy/subgraph/{id}`
    // so the browser never sees the upstream URL or hits api.goldsky.com
    // directly.
    accountVaultsSubgraphUrls: subgraphUrls,
    vaultTypeSubgraphUrls: subgraphUrls,
    ...adapterConfigForFastSource(fastSource),
    // Fallback chains short-circuit to the secondary (onchain/direct/subgraph)
    // when no upstream V3 is configured. Other sources have their adapters
    // pinned explicitly; v3-pinned without V3 will fail the SDK build (the
    // boot-time warning in api-url-env.ts flags this earlier).
    ...(fastSource === 'fallback' && !enableV3Backend ? { disableV3: true } : {}),
  }

  return {
    cacheKey: JSON.stringify(config),
    config,
  }
}

const buildRpcUrls = (): Record<number, string> => {
  const { allowedChainIds } = useEulerAddresses()
  const requestUrl = import.meta.server ? useRequestURL() : undefined
  const origin = requestUrl?.origin ?? ''

  return Object.fromEntries(
    allowedChainIds.value.map(chainId => [
      chainId,
      import.meta.server ? `${origin}/api/internal/rpc/${chainId}` : `/api/internal/rpc/${chainId}`,
    ]),
  )
}

const getRpcCacheKey = (rpcUrls: Record<number, string>) =>
  Object.entries(rpcUrls)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([chainId, rpcUrl]) => `${chainId}:${rpcUrl}`)
    .join('|')

const configureAppProxies = (sdk: EulerSDK, buildQuery: BuildQueryFn) => {
  const oracleAdapterService = sdk.oracleAdapterService as ConfigurableOracleAdapterService
  oracleAdapterService.setQueryOracleAdapters?.(buildQuery(
    'queryOracleAdapters',
    async (chainId: number) => {
      const response = await fetch(`${buildAppApiPath('/api/internal/oracle-adapters')}?chainId=${encodeURIComponent(String(chainId))}`)
      if (!response.ok) {
        throw new Error(`Oracle adapters request failed: ${response.status} ${response.statusText}`)
      }
      return response.json()
    },
    oracleAdapterService,
  ))
}

interface InstanceBuildArgs {
  backend: SdkBackend
  buildQuery: BuildQueryFn
}

const buildInstance = async ({ backend, buildQuery }: InstanceBuildArgs): Promise<SdkInstance> => {
  const rpcUrls = buildRpcUrls()
  const { config: staticConfig } = buildSdkStaticConfig(backend)
  const config: EulerSDKConfig = { ...staticConfig, rpcUrls }
  const { buildSdkKeyringHookTargets, getSdkKeyringCredential } = await loadSdkKeyringModule()
  const keyringHookTargets = buildSdkKeyringHookTargets()
  const intrinsicApyService = createYuzuIntrinsicApyService(
    new IntrinsicApyService(
      new IntrinsicApyV3Adapter(
        { endpoint: config.intrinsicApyV3ApiUrl ?? config.v3ApiUrl ?? buildV3ProxyApiPath() },
        buildQuery,
      ),
    ),
    buildAppApiPath('/api/internal/proxy/intrinsic-apy-overrides'),
  )

  const sdk = await buildEulerSDK({
    config,
    buildQuery,
    positionMigrationConnectorConfig: {
      morpho: { morphoGraphqlUrl: buildMorphoProxyApiPath() },
      aave: { graphqlEndpoint: buildAaveProxyApiPath() },
    },
    servicesOverrides: { intrinsicApyService },
    plugins: [
      createPythPlugin({ buildQuery, fetchFn: pythProxyFetch }),
      createKeyringPlugin({
        hookTargets: keyringHookTargets,
        getCredentialData: getSdkKeyringCredential,
        buildQuery,
      }),
      createLiteTosPlugin(),
    ],
  })
  configureAppProxies(sdk, buildQuery)
  return { sdk }
}

const lookupInstance = async (
  freshness: 'cached' | 'fresh',
  backend: SdkBackend,
  buildQuery: BuildQueryFn,
): Promise<SdkInstance> => {
  const rpcUrls = buildRpcUrls()
  const { cacheKey: staticCacheKey } = buildSdkStaticConfig(backend)
  const { buildSdkKeyringHookTargets } = await loadSdkKeyringModule()
  const keyringCacheKey = JSON.stringify(buildSdkKeyringHookTargets())
  const key = `${freshness}|${backend}|${getRpcCacheKey(rpcUrls)}|${staticCacheKey}|keyring:${keyringCacheKey}`
  let entry = instances.get(key)
  if (!entry) {
    entry = buildInstance({ backend, buildQuery }).catch((err) => {
      // Don't poison the map on transient build failure — drop the entry so
      // the next caller retries.
      if (instances.get(key) === entry) instances.delete(key)
      throw err
    })
    instances.set(key, entry)
  }
  return entry
}

/** "Fast" instance: adapter chain picked by `NUXT_PUBLIC_BROWSER_VAULT_SOURCE`
 *  (defaults to `fallback` — v3 primary, onchain secondary). When `fallback`
 *  is selected and no V3 endpoint is configured, `disableV3` short-circuits
 *  to onchain. */
export const getEulerSdk = async (): Promise<EulerSDK> => {
  const { sdk } = await lookupInstance('cached', 'fast', sdkBuildQuery)
  return sdk
}

export const getEulerSdkForChain = async (chainId: number): Promise<EulerSDK> => {
  const { onchainSdkChainIds } = useChainConfig()
  const backend: SdkBackend = onchainSdkChainIds.includes(chainId) ? 'onchain' : 'fast'
  const { sdk } = await lookupInstance('cached', backend, sdkBuildQuery)
  return sdk
}

/** "Slow"/plan-time instance: account and vault adapters stay onchain/subgraph
 *  regardless of browser source, with zero stale-time on plan-critical queries.
 *  Rewards use fallback so claim planning can combine V3 rows with direct
 *  provider proof data. Used by useEulerTx for plan construction, simulate,
 *  and execute. */
export const getEulerSdkFresh = async (): Promise<EulerSDK> => {
  const { sdk } = await lookupInstance('fresh', 'onchain', sdkFreshBuildQuery)
  return sdk
}

export const useEulerSdk = () => ({
  getEulerSdk,
  getEulerSdkForChain,
  getEulerSdkFresh,
})
