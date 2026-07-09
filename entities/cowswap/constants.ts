import type { SwapProviderExtraData, SwapQuote } from '@eulerxyz/euler-v2-sdk'

import { getCowSwapChainConfig } from '@eulerxyz/euler-v2-sdk'

export {
  COWSWAP_APPDATA_VERSION,
  COWSWAP_ORDER_DEADLINE_SECONDS,
  COWSWAP_ORDER_POLL_INTERVAL_MS,
  COWSWAP_ORDER_POLL_MAX_DURATION_MS,
  type CowSwapChainConfig,
  getCowSwapChainConfig,
} from '@eulerxyz/euler-v2-sdk'

export const COWSWAP_PROVIDER_NAME = 'cow'

export const COWSWAP_PROVIDER_EXTRA_DATA = {
  openPosition: { type: 'openPosition' } as SwapProviderExtraData,
  closePosition: { type: 'closePosition' } as SwapProviderExtraData,
  collateralSwap: (swapCollateralSharesAmountIn: bigint): SwapProviderExtraData => ({
    type: 'collateralSwap',
    swapCollateralSharesAmountIn,
  }),
} as const

export const isCowProvider = (provider: string | null | undefined): boolean =>
  !!provider && provider.toLowerCase() === COWSWAP_PROVIDER_NAME

export const isCowQuote = (quote: SwapQuote | null | undefined): boolean =>
  !!quote?.route?.some(r => r.providerName?.toLowerCase() === COWSWAP_PROVIDER_NAME)

export const isCowProviderOrQuote = (
  provider: string | null | undefined,
  quote: SwapQuote | null | undefined,
): boolean => isCowProvider(provider) || isCowQuote(quote)

export const isCowSwapSupportedChain = (chainId: number): boolean =>
  !!getCowSwapChainConfig(chainId)
