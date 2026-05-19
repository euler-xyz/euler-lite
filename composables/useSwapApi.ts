import { zeroAddress, type Address } from 'viem'
import type { SwapQuote, SwapQuoteRequest } from '@eulerxyz/euler-v2-sdk'
import { getEulerSdk } from '~/composables/useEulerSdk'
import { logWarn } from '~/utils/errorHandling'
import { EXCLUDED_SWAP_PROVIDERS, SWAP_DEFAULT_DEADLINE_SECONDS } from '~/entities/constants'

// Re-export the SDK's SwapQuoteRequest, but with the three environment-derived
// fields (chainId, origin, deadline) optional. The composable fills them from
// the current Wagmi/Euler context when callers omit them.
export type SwapQuoteInput
  = Omit<SwapQuoteRequest, 'chainId' | 'origin' | 'deadline'>
    & Partial<Pick<SwapQuoteRequest, 'chainId' | 'origin' | 'deadline'>>

const withDefaults = (
  params: SwapQuoteInput,
  fallbackChainId: number | undefined,
  fallbackOrigin: Address,
): SwapQuoteRequest | null => {
  const chainId = params.chainId ?? fallbackChainId
  if (!chainId) return null
  return {
    ...params,
    chainId,
    origin: params.origin ?? fallbackOrigin,
    deadline: params.deadline ?? Math.floor(Date.now() / 1000) + SWAP_DEFAULT_DEADLINE_SECONDS,
  }
}

export const useSwapApi = () => {
  const { chainId } = useEulerAddresses()
  const { address } = useWagmi()

  const getSwapQuotes = async (
    params: SwapQuoteInput,
    // Kept for source compatibility — the SDK does not accept an AbortSignal
    // today. The composable's race guard discards stale responses; in-flight
    // requests still run to completion.
    _options?: { signal?: AbortSignal },
  ): Promise<SwapQuote[]> => {
    if (!params.tokenIn || !params.tokenOut) return []

    const fallbackOrigin = (address.value ?? zeroAddress) as Address
    const request = withDefaults(params, chainId.value, fallbackOrigin)
    if (!request) return []

    const sdk = await getEulerSdk()
    return sdk.swapService.fetchSwapQuotes(request)
  }

  const getSwapProviders = async (): Promise<string[]> => {
    if (!chainId.value) return []
    try {
      const sdk = await getEulerSdk()
      const providers = await sdk.swapService.fetchProviders(chainId.value)
      return providers.filter(p => !EXCLUDED_SWAP_PROVIDERS.has(p.toLowerCase()))
    }
    catch (error) {
      logWarn('swapApi/providers', error)
      return []
    }
  }

  const getSwapQuote = async (
    params: SwapQuoteInput,
    options?: { signal?: AbortSignal },
  ): Promise<SwapQuote | null> => {
    const quotes = await getSwapQuotes(params, options)
    return quotes[0] || null
  }

  return {
    getSwapQuote,
    getSwapQuotes,
    getSwapProviders,
  }
}
