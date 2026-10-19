import { IntrinsicApyService, type EulerSDK, type PriceService, type TokenlistService } from '@eulerxyz/euler-v2-sdk'

export const createNoV3IntrinsicApyService = () => new IntrinsicApyService({
  fetchIntrinsicApy: async () => undefined,
  fetchChainIntrinsicApys: async () => new Map(),
})

/** Lite builds these SDK services with their built-in implementations. Keep
 * on-chain pricing and token-decimal reads while disabling their HTTP sources. */
export function disableSdkV3Utilities(sdk: Pick<EulerSDK, 'priceService' | 'tokenlistService'>): void {
  const priceService = sdk.priceService as PriceService
  const tokenlistService = sdk.tokenlistService as TokenlistService
  priceService.setBackendClient(undefined)
  tokenlistService.setQueryTokenList(async () => [])
}
