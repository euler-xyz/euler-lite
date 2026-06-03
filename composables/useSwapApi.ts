import { zeroAddress, type Address } from 'viem'
import type { SwapProviderExtraData, SwapQuote, SwapQuoteRequest } from '@eulerxyz/euler-v2-sdk'
import { getEulerSdk } from '~/composables/useEulerSdk'
import { logWarn } from '~/utils/errorHandling'
import { EXCLUDED_SWAP_PROVIDERS, SWAP_DEFAULT_DEADLINE_SECONDS } from '~/entities/constants'
import { COWSWAP_PROVIDER_NAME, isCowSwapSupportedChain } from '~/entities/cowswap'

// Re-export the SDK's SwapQuoteRequest, but with the three environment-derived
// fields (chainId, origin, deadline) optional. The composable fills them from
// the current Wagmi/Euler context when callers omit them.
export type SwapQuoteInput
  = Omit<SwapQuoteRequest, 'chainId' | 'origin' | 'deadline'>
    & Partial<Pick<SwapQuoteRequest, 'chainId' | 'origin' | 'deadline'>>

// Alias kept for parity with `origin/development`'s call sites; the dev branch
// names this `SwapApiRequestInput`. Same shape — pick whichever reads better
// at the call site.
export type SwapApiRequestInput = SwapQuoteInput

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
  const { isSpyMode, spyAddress } = useSpyMode()

  const getSwapQuotes = async (
    params: SwapQuoteInput,
    // Kept for source compatibility — the SDK does not accept an AbortSignal
    // today. The composable's race guard discards stale responses; in-flight
    // requests still run to completion.
    _options?: { signal?: AbortSignal },
  ): Promise<SwapQuote[]> => {
    if (!params.tokenIn || !params.tokenOut) return []

    // Spy mode has no connected wallet, so address.value is empty. Falling
    // through to zeroAddress makes every aggregator reject the request as the
    // simulating `from` is invalid. Use the spied owner instead so providers
    // see a real address with realistic balances/allowances.
    const spyOrigin = isSpyMode.value && spyAddress.value ? spyAddress.value as Address : null
    const fallbackOrigin = (address.value ?? spyOrigin ?? zeroAddress) as Address
    const request = withDefaults(params, chainId.value, fallbackOrigin)
    if (!request) return []

    const sdk = await getEulerSdk()
    return sdk.swapService.fetchSwapQuotes(request)
  }

  // `includeCowSwap` lets the parallel-quotes pipeline opt CoW back in for
  // pages that wire CoW execution (multiply / repay-with-collateral). The
  // baseline excludes CoW because most legacy code paths assume an EVC
  // batch, not an intent.
  const getSwapProviders = async (
    options?: { includeCowSwap?: boolean },
  ): Promise<string[]> => {
    if (!chainId.value) return []
    try {
      const sdk = await getEulerSdk()
      const providers = await sdk.swapService.fetchProviders(chainId.value)
      const includeCow = options?.includeCowSwap && isCowSwapSupportedChain(chainId.value)
      return providers.filter((p) => {
        const normalized = p.toLowerCase()
        return !EXCLUDED_SWAP_PROVIDERS.has(normalized)
          && (normalized !== COWSWAP_PROVIDER_NAME || includeCow)
      })
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

// Re-export the SDK's provider-extra-data type so call sites that want to
// type-check their CoW wrapper payloads don't need to reach into the SDK.
export type { SwapProviderExtraData }
