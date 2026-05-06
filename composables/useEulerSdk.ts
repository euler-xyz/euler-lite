import { buildEulerSDK, createPythPlugin } from '@eulerxyz/euler-v2-sdk'
import type { EulerSDK } from '@eulerxyz/euler-v2-sdk'
import { sdkBuildQuery } from '~/utils/sdk-query-cache'

type SdkBuild = { key: string, promise?: Promise<EulerSDK> }

const DEFAULT_EULER_CHAINS_URL = 'https://raw.githubusercontent.com/euler-xyz/euler-interfaces/refs/heads/master/EulerChains.json'
const DEFAULT_LABELS_REPO = 'euler-xyz/euler-labels'
const DEFAULT_LABELS_BRANCH = 'master'
const DEFAULT_ORACLE_CHECKS_REPO = 'euler-xyz/oracle-checks'

let sdkInstance: { key: string, sdk: EulerSDK } | undefined
let sdkBuild: SdkBuild | undefined

const getPublicRuntimeConfig = (): Record<string, string> => {
  if (typeof useRuntimeConfig !== 'function') return {}
  return useRuntimeConfig().public as unknown as Record<string, string>
}

const buildStaticDataConfig = () => {
  const rc = getPublicRuntimeConfig()
  const labelsRepo = rc.configLabelsRepo || DEFAULT_LABELS_REPO
  const labelsBranch = rc.configLabelsRepoBranch || DEFAULT_LABELS_BRANCH
  const labelsBaseUrl = (rc.configLabelsBaseUrl || `https://raw.githubusercontent.com/${labelsRepo}/refs/heads/${labelsBranch}`).replace(/\/+$/, '')
  const oracleChecksRepo = rc.configOracleChecksRepo || DEFAULT_ORACLE_CHECKS_REPO
  const oracleChecksBaseUrl = (rc.configOracleChecksBaseUrl || `https://raw.githubusercontent.com/${oracleChecksRepo}/refs/heads/master/data`).replace(/\/+$/, '')

  return {
    cacheKey: JSON.stringify({
      deploymentsUrl: (rc.configEulerChainsUrl || DEFAULT_EULER_CHAINS_URL).trim(),
      labelsBaseUrl,
      oracleChecksBaseUrl,
    }),
    deploymentServiceConfig: {
      deploymentsUrl: (rc.configEulerChainsUrl || DEFAULT_EULER_CHAINS_URL).trim(),
    },
    eulerLabelsAdapterConfig: {
      getEulerLabelsEntitiesUrl: (chainId: number) => `${labelsBaseUrl}/${chainId}/entities.json`,
      getEulerLabelsProductsUrl: (chainId: number) => `${labelsBaseUrl}/${chainId}/products.json`,
      getEulerLabelsPointsUrl: (chainId: number) => `${labelsBaseUrl}/${chainId}/points.json`,
      getEulerLabelsEarnVaultsUrl: (chainId: number) => `${labelsBaseUrl}/${chainId}/earn-vaults.json`,
      getEulerLabelsAssetsUrl: (chainId: number) => `${labelsBaseUrl}/${chainId}/assets.json`,
      getEulerLabelsGlobalAssetsUrl: () => `${labelsBaseUrl}/all/assets.json`,
      getEulerLabelsLogoUrl: (filename: string) => `${labelsBaseUrl}/logo/${filename}`,
    },
    oracleAdapterServiceConfig: {
      baseUrl: oracleChecksBaseUrl,
    },
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
  const { cacheKey, ...staticDataConfig } = buildStaticDataConfig()
  const nextKey = getSdkKey(rpcUrls, cacheKey)

  if (sdkInstance?.key === nextKey) return sdkInstance.sdk
  if (sdkBuild?.key === nextKey && sdkBuild.promise) return sdkBuild.promise

  const buildKey = nextKey
  const buildState: SdkBuild = { key: buildKey }
  const buildPromise = buildEulerSDK({
    rpcUrls,
    buildQuery: sdkBuildQuery,
    plugins: [createPythPlugin({ buildQuery: sdkBuildQuery })],
    ...staticDataConfig,
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
