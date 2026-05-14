import { buildEulerSDK, createPythPlugin } from '@eulerxyz/euler-v2-sdk'
import type { EulerSDK, EulerSDKConfig } from '@eulerxyz/euler-v2-sdk'
import { sdkBuildQuery } from '~/utils/sdk-query-cache'

type SdkBuild = { key: string, promise?: Promise<EulerSDK> }
type QueryOracleAdapters = (chainId: number) => Promise<unknown>
type ConfigurableOracleAdapterService = EulerSDK['oracleAdapterService'] & {
  setQueryOracleAdapters?: (fn: QueryOracleAdapters) => void
}

let sdkInstance: { key: string, sdk: EulerSDK } | undefined
let sdkBuild: SdkBuild | undefined

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

const buildSdkStaticConfig = () => {
  const rc = getPublicRuntimeConfig()
  const { enableMerkl, enableIncentra, enableFuul } = useDeployConfig()
  const labelsBaseUrl = cleanUrl(rc.configLabelsBaseUrl)
  const oracleChecksBaseUrl = cleanUrl(rc.configOracleChecksBaseUrl)
  const v3ApiUrl = buildV3ProxyApiPath()
  const config: EulerSDKConfig = {
    ...(v3ApiUrl ? { v3ApiUrl, tokenlistApiBaseUrl: v3ApiUrl } : {}),
    deploymentsUrl: buildAppApiPath('/api/euler-chains'),
    ...(labelsBaseUrl ? { eulerLabelsBaseUrl: labelsBaseUrl } : {}),
    ...(oracleChecksBaseUrl ? { oracleAdaptersBaseUrl: oracleChecksBaseUrl } : {}),
    ...(enableMerkl ? {} : { rewardsEnableMerkl: false }),
    ...(enableIncentra ? {} : { rewardsEnableBrevis: false }),
    ...(enableFuul ? {} : { rewardsEnableFuul: false }),
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

const getSdkKey = (rpcUrls: Record<number, string>, staticDataCacheKey: string) =>
  [
    ...Object.entries(rpcUrls)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([chainId, rpcUrl]) => `${chainId}:${rpcUrl}`),
    staticDataCacheKey,
  ].join('|')

const configureAppProxies = (sdk: EulerSDK) => {
  const oracleAdapterService = sdk.oracleAdapterService as ConfigurableOracleAdapterService
  oracleAdapterService.setQueryOracleAdapters?.(sdkBuildQuery(
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

export const getEulerSdk = async (): Promise<EulerSDK> => {
  const rpcUrls = buildRpcUrls()
  const { cacheKey, config: staticConfig } = buildSdkStaticConfig()
  const config: EulerSDKConfig = {
    ...staticConfig,
    rpcUrls,
  }
  const nextKey = getSdkKey(rpcUrls, cacheKey)

  if (sdkInstance?.key === nextKey) return sdkInstance.sdk
  if (sdkBuild?.key === nextKey && sdkBuild.promise) return sdkBuild.promise

  const buildKey = nextKey
  const buildState: SdkBuild = { key: buildKey }
  const buildPromise = buildEulerSDK({
    config,
    buildQuery: sdkBuildQuery,
    plugins: [createPythPlugin({ buildQuery: sdkBuildQuery })],
  }).then((sdk) => {
    configureAppProxies(sdk)
    if (sdkBuild === buildState) {
      sdkInstance = { key: buildKey, sdk }
      sdkBuild = undefined
    }
    return sdk
  })
    .catch((error) => {
      if (sdkBuild === buildState) {
        sdkBuild = undefined
      }
      throw error
    })

  buildState.promise = buildPromise
  sdkBuild = buildState
  return buildPromise
}

export const useEulerSdk = () => ({
  getEulerSdk,
})
