import { buildEulerSDK, createPythPlugin } from '@eulerxyz/euler-v2-sdk'
import type { EulerSDK, EulerSDKConfig } from '@eulerxyz/euler-v2-sdk'
import { sdkBuildQuery } from '~/utils/sdk-query-cache'

type SdkBuild = { key: string, promise?: Promise<EulerSDK> }

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

const buildSdkStaticConfig = () => {
  const rc = getPublicRuntimeConfig()
  const { enableMerkl, enableIncentra, enableFuul } = useDeployConfig()
  const deploymentsUrl = cleanUrl(rc.configEulerChainsUrl)
  const labelsBaseUrl = cleanUrl(rc.configLabelsBaseUrl)
  const oracleChecksBaseUrl = cleanUrl(rc.configOracleChecksBaseUrl)
  const config: EulerSDKConfig = {
    ...(deploymentsUrl ? { deploymentsUrl } : {}),
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
