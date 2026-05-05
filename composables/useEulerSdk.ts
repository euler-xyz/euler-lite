import { buildEulerSDK, createPythPlugin } from '@eulerxyz/euler-v2-sdk'
import type { EulerSDK } from '@eulerxyz/euler-v2-sdk'
import { sdkBuildQuery } from '~/utils/sdk-query-cache'

let sdkInstance: EulerSDK | undefined
let sdkPromise: Promise<EulerSDK> | undefined
let sdkKey: string | undefined

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

  if (sdkInstance && sdkKey === nextKey) return sdkInstance
  if (sdkPromise && sdkKey === nextKey) return sdkPromise

  const { SWAP_API_URL } = useEulerConfig()
  sdkKey = nextKey
  sdkPromise = buildEulerSDK({
    rpcUrls,
    buildQuery: sdkBuildQuery,
    plugins: [createPythPlugin({ buildQuery: sdkBuildQuery })],
    swapServiceConfig: {
      swapApiUrl: SWAP_API_URL || '/api/swap',
    },
  }).then((sdk) => {
    sdkInstance = sdk
    return sdk
  })

  return sdkPromise
}

export const useEulerSdk = () => ({
  getEulerSdk,
})
