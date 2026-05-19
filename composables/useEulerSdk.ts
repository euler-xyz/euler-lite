import { buildEulerSDK, createKeyringPlugin, createPythPlugin } from '@eulerxyz/euler-v2-sdk'
import type { BuildQueryFn, EulerSDK, EulerSDKConfig } from '@eulerxyz/euler-v2-sdk'
import { sdkBuildQuery, sdkFreshBuildQuery } from '~/utils/sdk-query-cache'
import { createLiteTosPlugin } from '~/utils/sdk-tos'

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

/**
 * Two SDK instances are exposed:
 *
 *   - `getEulerSdk()`  — "fast" / browsing instance. Uses the SDK's built-in
 *     `'fallback'` adapter mode: V3 HTTP primary with on-chain secondary, wired
 *     by the SDK via `createFallbackAdapter`. When the deployment has no V3
 *     upstream configured (`enableV3Backend` false), we set `disableV3: true`
 *     so the fallback chain degrades to onchain only. Uses the default
 *     `sdkBuildQuery` cache policy (sub-minute stale times for hot reads,
 *     longer for static catalogue data). Consumed by UI surfaces: vault lists,
 *     portfolio display, prices, rewards.
 *
 *   - `getEulerSdkFresh()`  — "slow" / plan-time instance. Always uses on-chain
 *     adapters directly (no fallback wrapping) so the Account/Vault state used
 *     to build a transaction plan reflects the latest block. Uses
 *     `sdkFreshBuildQuery`, which forces a zero stale time on plan-critical
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

const buildV3ProxyApiPath = () => buildAppApiPath('/api/v3')

type SdkBackend = 'fallback' | 'onchain'

const fallbackAdapterConfig: Partial<EulerSDKConfig> = {
  accountServiceAdapter: 'fallback',
  eVaultServiceAdapter: 'fallback',
  eulerEarnServiceAdapter: 'fallback',
  vaultTypeAdapter: 'fallback',
  rewardsServiceAdapter: 'fallback',
}

const onchainAdapterConfig: Partial<EulerSDKConfig> = {
  accountServiceAdapter: 'onchain',
  eVaultServiceAdapter: 'onchain',
  eulerEarnServiceAdapter: 'onchain',
  vaultTypeAdapter: 'subgraph',
  rewardsServiceAdapter: 'direct',
}

const buildSdkStaticConfig = (backend: SdkBackend) => {
  const rc = getPublicRuntimeConfig()
  const { enableMerkl, enableIncentra, enableFuul } = useDeployConfig()
  const labelsBaseUrl = cleanUrl(rc.configLabelsBaseUrl)
  const oracleChecksBaseUrl = cleanUrl(rc.configOracleChecksBaseUrl)
  const swapApiUrl = cleanUrl(rc.swapApiUrl)
  const v3ApiUrl = buildV3ProxyApiPath()
  const { enableV3Backend } = useEnvConfig()
  const config: EulerSDKConfig = {
    // The proxy path is wired regardless of `backend` so that the SDK can still
    // resolve v3-only utility endpoints (tokenlist) when adapters that fall
    // back to v3 internally are encountered. The per-service adapter flags are
    // what actually steer reads through the fallback chain vs straight onchain.
    ...(v3ApiUrl ? { v3ApiUrl, tokenlistApiBaseUrl: v3ApiUrl } : {}),
    deploymentsUrl: buildAppApiPath('/api/euler-chains'),
    ...(labelsBaseUrl ? { eulerLabelsBaseUrl: labelsBaseUrl } : {}),
    ...(oracleChecksBaseUrl ? { oracleAdaptersBaseUrl: oracleChecksBaseUrl } : {}),
    ...(swapApiUrl ? { swapApiUrl } : {}),
    ...(enableMerkl ? {} : { rewardsEnableMerkl: false }),
    ...(enableIncentra ? {} : { rewardsEnableBrevis: false }),
    ...(enableFuul ? {} : { rewardsEnableFuul: false }),
    ...(backend === 'fallback' ? fallbackAdapterConfig : onchainAdapterConfig),
    // Fallback chains short-circuit to the secondary (onchain/direct/subgraph)
    // when no upstream V3 is configured. Slow/onchain backend ignores this
    // since its per-service adapters are pinned explicitly.
    ...(backend === 'fallback' && !enableV3Backend ? { disableV3: true } : {}),
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
      import.meta.server ? `${origin}/api/rpc/${chainId}` : `/api/rpc/${chainId}`,
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
      const response = await fetch(`${buildAppApiPath('/api/oracle-adapters')}?chainId=${encodeURIComponent(String(chainId))}`)
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

  const sdk = await buildEulerSDK({
    config,
    buildQuery,
    plugins: [
      createPythPlugin({ buildQuery }),
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

/** "Fast" instance: SDK fallback adapters (v3 primary, onchain secondary).
 *  When `enableV3Backend` is false, `disableV3` short-circuits to onchain. */
export const getEulerSdk = async (): Promise<EulerSDK> => {
  const { sdk } = await lookupInstance('cached', 'fallback', sdkBuildQuery)
  return sdk
}

/** "Slow"/plan-time instance: always onchain adapters, zero stale-time on
 *  plan-critical queries. Used by useEulerTx for plan construction, simulate,
 *  and execute. */
export const getEulerSdkFresh = async (): Promise<EulerSDK> => {
  const { sdk } = await lookupInstance('fresh', 'onchain', sdkFreshBuildQuery)
  return sdk
}

export const useEulerSdk = () => ({
  getEulerSdk,
  getEulerSdkFresh,
})
