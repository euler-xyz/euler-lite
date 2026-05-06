import { buildEulerSDK, createPythPlugin } from '@eulerxyz/euler-v2-sdk'
import type { EulerSDK } from '@eulerxyz/euler-v2-sdk'
import { sdkBuildQuery } from '~/utils/sdk-query-cache'

type SdkBuild = { key: string, promise?: Promise<EulerSDK> }

let sdkInstance: { key: string, sdk: EulerSDK } | undefined
let sdkBuild: SdkBuild | undefined

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

const getSdkKey = (rpcUrls: Record<number, string>) =>
  Object.entries(rpcUrls)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([chainId, rpcUrl]) => `${chainId}:${rpcUrl}`)
    .join('|')

export const getEulerSdk = async (): Promise<EulerSDK> => {
  const rpcUrls = buildRpcUrls()
  const nextKey = getSdkKey(rpcUrls)

  if (sdkInstance?.key === nextKey) return sdkInstance.sdk
  if (sdkBuild?.key === nextKey && sdkBuild.promise) return sdkBuild.promise

  const buildKey = nextKey
  const buildState: SdkBuild = { key: buildKey }
  const buildPromise = buildEulerSDK({
    rpcUrls,
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
