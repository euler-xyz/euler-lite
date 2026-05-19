import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, ref, watch } from 'vue'
import { SwapperMode, type SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { useSwapQuotesParallel } from '~/composables/useSwapQuotesParallel'

const makeQuote = (amountIn: string, amountOut: string): SwapQuote =>
  ({ amountIn, amountOut }) as SwapQuote

const requestParams = {
  tokenIn: '0x0000000000000000000000000000000000000001',
  tokenOut: '0x0000000000000000000000000000000000000002',
  accountIn: '0x0000000000000000000000000000000000000003',
  accountOut: '0x0000000000000000000000000000000000000004',
  amount: 100n,
  vaultIn: '0x0000000000000000000000000000000000000005',
  receiver: '0x0000000000000000000000000000000000000006',
  slippage: 1,
  swapperMode: SwapperMode.EXACT_IN,
  isRepay: false,
  targetDebt: 0n,
  currentDebt: 0n,
} as const satisfies Parameters<ReturnType<typeof useSwapQuotesParallel>['requestQuotes']>[0]

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0))

describe('useSwapQuotesParallel', () => {
  let getSwapProviders: ReturnType<typeof vi.fn>
  let getSwapQuotes: ReturnType<typeof vi.fn>

  beforeEach(() => {
    getSwapProviders = vi.fn()
    getSwapQuotes = vi.fn()

    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('useSwapApi', () => ({
      getSwapProviders,
      getSwapQuotes,
    }))
    vi.stubGlobal('useRpcClient', () => ({ client: ref(null) }))
    vi.stubGlobal('useWagmi', () => ({
      address: ref('0x0000000000000000000000000000000000000007'),
      chain: ref({ nativeCurrency: { decimals: 18 } }),
    }))
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  })

  it('keeps effectiveQuote stable when selecting the current best provider', async () => {
    const firstQuote = makeQuote('100', '200')
    getSwapProviders.mockResolvedValue(['first'])
    getSwapQuotes.mockResolvedValue([firstQuote])

    const quotes = useSwapQuotesParallel({ amountField: 'amountOut', compare: 'max' })
    await quotes.requestQuotes(requestParams)
    await flushPromises()
    await nextTick()

    const changes: Array<SwapQuote | null> = []
    watch(quotes.effectiveQuote, quote => changes.push(quote))

    quotes.selectProvider('first')
    await nextTick()

    expect(quotes.selectedProvider.value).toBe('first')
    expect(quotes.selectedQuote.value).toBe(quotes.effectiveQuote.value)
    expect(changes).toEqual([])
  })

  it('updates effectiveQuote when selecting a non-best provider', async () => {
    const bestQuote = makeQuote('100', '300')
    const otherQuote = makeQuote('100', '200')
    getSwapProviders.mockResolvedValue(['best', 'other'])
    getSwapQuotes.mockImplementation(({ provider }: { provider: string }) =>
      Promise.resolve([provider === 'best' ? bestQuote : otherQuote]),
    )

    const quotes = useSwapQuotesParallel({ amountField: 'amountOut', compare: 'max' })
    await quotes.requestQuotes(requestParams)
    await flushPromises()
    await nextTick()

    const changes: Array<SwapQuote | null> = []
    watch(quotes.effectiveQuote, quote => changes.push(quote))

    quotes.selectProvider('other')
    await nextTick()

    expect(quotes.selectedProvider.value).toBe('other')
    expect(quotes.effectiveQuote.value?.amountOut).toBe('200')
    expect(changes).toHaveLength(1)
  })

  it('applies provider-specific request params and extra data', async () => {
    const cowQuote = makeQuote('100', '300')
    const otherQuote = makeQuote('100', '200')
    const cowAccount = '0x00000000000000000000000000000000000000c0'
    const cowProviderExtraData = { type: 'openPosition' as const, appData: '{}' }
    getSwapProviders.mockResolvedValue(['cow', 'other'])
    getSwapQuotes.mockImplementation(({ provider }: { provider: string }) =>
      Promise.resolve([provider === 'cow' ? cowQuote : otherQuote]),
    )

    const quotes = useSwapQuotesParallel({ amountField: 'amountOut', compare: 'max', includeCowSwap: true })
    await quotes.requestQuotes(requestParams, {
      providerExtraData: { cow: cowProviderExtraData },
      providerParams: {
        cow: {
          accountIn: cowAccount,
          accountOut: cowAccount,
        },
      },
    })
    await flushPromises()
    await nextTick()

    const cowCall = getSwapQuotes.mock.calls.find(([params]) => params.provider === 'cow')?.[0]
    const otherCall = getSwapQuotes.mock.calls.find(([params]) => params.provider === 'other')?.[0]

    expect(cowCall).toMatchObject({
      provider: 'cow',
      accountIn: cowAccount,
      accountOut: cowAccount,
      providerExtraData: cowProviderExtraData,
    })
    expect(otherCall).toMatchObject({
      provider: 'other',
      accountIn: requestParams.accountIn,
      accountOut: requestParams.accountOut,
    })
    expect(otherCall.providerExtraData).toBeUndefined()
  })
})
