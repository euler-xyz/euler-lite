import axios from 'axios'
import { zeroAddress, type Address } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import {
  type RoutingConfig,
  type SwapApiQuote,
  type SwapApiResponse,
  SwapperMode,
} from '~/entities/swap'
import { EXCLUDED_SWAP_PROVIDERS, SWAP_DEFAULT_DEADLINE_SECONDS } from '~/entities/constants'
import { COWSWAP_PROVIDER_NAME, isCowSwapSupportedChain } from '~/entities/cowswap'

export interface SwapApiRequestInput {
  chainId?: number
  tokenIn: Address
  tokenOut: Address
  accountIn: Address
  accountOut: Address
  amount: bigint
  vaultIn: Address
  receiver: Address
  origin?: Address
  slippage?: number
  swapperMode?: SwapperMode
  isRepay?: boolean
  targetDebt?: bigint
  currentDebt?: bigint
  deadline?: number
  dustAccount?: Address
  unusedInputReceiver?: Address
  transferOutputToReceiver?: boolean
  routingOverride?: RoutingConfig
  provider?: string
}

const buildRequestParams = (
  chainId: number | undefined,
  origin: Address,
  params: SwapApiRequestInput,
  deadline: number,
) => {
  const requestParams: Record<string, string | number | undefined> = {
    chainId,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amount: params.amount?.toString(),
    targetDebt: params.targetDebt?.toString() || '0',
    currentDebt: params.currentDebt?.toString() || '0',
    receiver: params.receiver,
    vaultIn: params.vaultIn,
    origin,
    accountIn: params.accountIn,
    accountOut: params.accountOut,
    slippage: params.slippage?.toString() || '0',
    deadline,
    swapperMode: params.swapperMode ?? SwapperMode.EXACT_IN,
    isRepay: String(params.isRepay ?? false),
    dustAccount: params.dustAccount || origin,
    unusedInputReceiver: params.unusedInputReceiver,
    transferOutputToReceiver: params.transferOutputToReceiver != null ? String(params.transferOutputToReceiver) : undefined,
    routingOverride: params.routingOverride ? JSON.stringify(params.routingOverride) : undefined,
    provider: params.provider,
  }

  return Object.fromEntries(
    Object.entries(requestParams).filter(([, value]) => value !== undefined && value !== null),
  )
}

const parseSwapApiResponse = (payload: SwapApiResponse | { data?: SwapApiQuote[] }) => {
  if ('success' in payload && payload.success === false) {
    throw new Error('Swap API returned success=false')
  }
  if ('data' in payload && Array.isArray(payload.data)) {
    return payload.data
  }
  return []
}

const parseSwapProvidersResponse = (payload: { success?: boolean, data?: string[] }) => {
  if ('success' in payload && payload.success === false) {
    throw new Error('Swap API returned success=false')
  }
  if ('data' in payload && Array.isArray(payload.data)) {
    return payload.data
  }
  return []
}

export const useSwapApi = () => {
  const { SWAP_API_URL } = useEulerConfig()
  const { chainId } = useEulerAddresses()
  const { address } = useWagmi()

  const baseUrl = SWAP_API_URL

  const getSwapQuotes = async (
    params: SwapApiRequestInput,
    options?: { signal?: AbortSignal },
  ): Promise<SwapApiQuote[]> => {
    if (!params.tokenIn || !params.tokenOut) {
      return []
    }

    const origin = params.origin || address.value || zeroAddress
    const deadline = params.deadline || (Math.floor(Date.now() / 1000) + SWAP_DEFAULT_DEADLINE_SECONDS)
    const requestParams = buildRequestParams(chainId.value, origin, params, deadline)

    const response = await axios.get<SwapApiResponse>(
      `${baseUrl}/swaps`,
      {
        params: requestParams,
        signal: options?.signal,
      },
    )

    return parseSwapApiResponse(response.data)
  }

  const getSwapProviders = async (options?: { includeCowSwap?: boolean }): Promise<string[]> => {
    if (!chainId.value) {
      return []
    }
    try {
      const response = await axios.get<{ success?: boolean, data?: string[] }>(
        `${baseUrl}/providers`,
        {
          params: {
            chainId: chainId.value,
          },
        },
      )
      const providers = parseSwapProvidersResponse(response.data)
      const includeCow = options?.includeCowSwap && isCowSwapSupportedChain(chainId.value ?? 0)
      return providers.filter(p =>
        !EXCLUDED_SWAP_PROVIDERS.has(p)
        && (p.toLowerCase() !== COWSWAP_PROVIDER_NAME || includeCow),
      )
    }
    catch (error) {
      logWarn('swapApi/providers', error)
      return []
    }
  }

  const getSwapQuote = async (
    params: SwapApiRequestInput,
    options?: { signal?: AbortSignal },
  ): Promise<SwapApiQuote | null> => {
    const quotes = await getSwapQuotes(params, options)
    return quotes[0] || null
  }

  const logSwapFailure = async (payload: unknown) => {
    try {
      await axios.post(`${baseUrl}/log`, payload)
    }
    catch (error) {
      logWarn('swapApi/log', error)
    }
  }

  return {
    baseUrl,
    getSwapQuote,
    getSwapQuotes,
    getSwapProviders,
    logSwapFailure,
  }
}
