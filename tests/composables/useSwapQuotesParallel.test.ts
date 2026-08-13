import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, ref, watch } from 'vue'
import { SwapperMode, type SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { useSwapQuotesParallel } from '~/composables/useSwapQuotesParallel'

const { getTokenUsdValueMock } = vi.hoisted(() => ({
  getTokenUsdValueMock: vi.fn(),
}))

vi.mock('~/utils/sdk-prices', () => ({
  getTokenUsdValue: getTokenUsdValueMock,
}))

const makeQuote = (amountIn: string, amountOut: string): SwapQuote =>
  ({ amountIn, amountOut }) as SwapQuote

const makeUsdcOutQuote = (amountOut: string): SwapQuote =>
  ({
    amountIn: '100',
    amountOut,
    tokenOut: {
      address: '0x0000000000000000000000000000000000000002',
      decimals: 6,
    },
  }) as unknown as SwapQuote

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
    getTokenUsdValueMock.mockReset()
    getTokenUsdValueMock.mockImplementation(async (amount: bigint, decimals: number) =>
      Number(amount) / 10 ** decimals,
    )

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
    vi.stubGlobal('usePlanAccount', () => ({ account: ref(undefined) }))
    vi.stubGlobal('useSpyMode', () => ({
      isSpyMode: ref(false),
      spyAddress: ref(null),
    }))
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

  it('scores CoW quotes with zero gas instead of pushing them behind priced routes', async () => {
    const cowQuote = makeUsdcOutQuote('213000000000')
    const otherQuote = makeUsdcOutQuote('212900000000')
    getSwapProviders.mockResolvedValue(['other', 'cow'])
    getSwapQuotes.mockImplementation(({ provider }: { provider: string }) =>
      Promise.resolve([provider === 'cow' ? cowQuote : otherQuote]),
    )

    const quotes = useSwapQuotesParallel({ amountField: 'amountOut', compare: 'max', includeCowSwap: true })
    await quotes.requestQuotes(requestParams)
    await flushPromises()
    await nextTick()

    expect(quotes.sortedQuoteCards.value[0]).toMatchObject({
      provider: 'cow',
      amountUsd: 213000,
      gasCostUsd: 0,
      isGasless: true,
    })
    expect(quotes.sortedQuoteCards.value[1].provider).toBe('other')
  })

  it('evaluates callable includeCowSwap for each quote request', async () => {
    let includeCowSwap = true
    getSwapProviders.mockResolvedValue([])

    const quotes = useSwapQuotesParallel({
      amountField: 'amountOut',
      compare: 'max',
      includeCowSwap: () => includeCowSwap,
    })

    await quotes.requestQuotes(requestParams)
    includeCowSwap = false
    await quotes.requestQuotes(requestParams)

    expect(getSwapProviders).toHaveBeenNthCalledWith(1, { includeCowSwap: true })
    expect(getSwapProviders).toHaveBeenNthCalledWith(2, { includeCowSwap: false })
  })

  it('removes existing CoW quote cards when callable includeCowSwap becomes false', async () => {
    const includeCowSwap = ref(true)
    const cowQuote = makeQuote('100', '300')
    const otherQuote = makeQuote('100', '200')
    getSwapProviders.mockResolvedValue(['cow', 'other'])
    getSwapQuotes.mockImplementation(({ provider }: { provider: string }) =>
      Promise.resolve([provider === 'cow' ? cowQuote : otherQuote]),
    )

    const quotes = useSwapQuotesParallel({
      amountField: 'amountOut',
      compare: 'max',
      includeCowSwap: () => includeCowSwap.value,
    })

    await quotes.requestQuotes(requestParams)
    await flushPromises()
    await nextTick()

    expect(quotes.sortedQuoteCards.value.map(card => card.provider)).toEqual(['cow', 'other'])

    quotes.selectProvider('cow')
    includeCowSwap.value = false
    await nextTick()

    expect(quotes.sortedQuoteCards.value.map(card => card.provider)).toEqual(['other'])
    expect(quotes.selectedProvider.value).toBeNull()
  })

  it('drops an in-flight CoW response that resolves after the gate flips to false', async () => {
    const includeCowSwap = ref(true)
    const otherQuote = makeQuote('100', '200')
    let releaseCowQuote!: (quotes: SwapQuote[]) => void
    getSwapProviders.mockResolvedValue(['cow', 'other'])
    getSwapQuotes.mockImplementation(({ provider }: { provider: string }) =>
      provider === 'cow'
        ? new Promise<SwapQuote[]>((resolve) => {
            releaseCowQuote = resolve
          })
        : Promise.resolve([otherQuote]),
    )

    const quotes = useSwapQuotesParallel({
      amountField: 'amountOut',
      compare: 'max',
      includeCowSwap: () => includeCowSwap.value,
    })

    await quotes.requestQuotes(requestParams)
    await flushPromises()
    await nextTick()
    expect(quotes.sortedQuoteCards.value.map(card => card.provider)).toEqual(['other'])

    // The gate flips (e.g. Safe detection lands) while the CoW request is
    // still in flight — same sweep generation, so the staleness guard does
    // not cover it.
    includeCowSwap.value = false
    await nextTick()

    releaseCowQuote([makeQuote('100', '300')])
    await flushPromises()
    await nextTick()

    // The resolved CoW card must not reinsert past the eviction.
    expect(quotes.sortedQuoteCards.value.map(card => card.provider)).toEqual(['other'])
  })

  it('replays the sweep when CoW eligibility resolves after a gated sweep', async () => {
    const includeCowSwap = ref(false)
    const cowQuote = makeQuote('100', '300')
    const otherQuote = makeQuote('100', '200')
    getSwapProviders.mockImplementation(async ({ includeCowSwap: include }: { includeCowSwap?: boolean }) =>
      include ? ['cow', 'other'] : ['other'],
    )
    getSwapQuotes.mockImplementation(({ provider }: { provider: string }) =>
      Promise.resolve([provider === 'cow' ? cowQuote : otherQuote]),
    )

    const quotes = useSwapQuotesParallel({
      amountField: 'amountOut',
      compare: 'max',
      includeCowSwap: () => includeCowSwap.value,
    })

    // Sweep made during the fail-closed detection window — CoW resolved out
    // of the provider list entirely.
    await quotes.requestQuotes(requestParams)
    await flushPromises()
    await nextTick()
    expect(quotes.sortedQuoteCards.value.map(card => card.provider)).toEqual(['other'])

    // Detection lands on a regular wallet: eligibility resolves to true.
    includeCowSwap.value = true
    await nextTick()
    await flushPromises()
    await nextTick()

    // The reduced quote set must not persist until the next input change —
    // the sweep replays with the full provider list.
    expect(getSwapProviders).toHaveBeenLastCalledWith({ includeCowSwap: true })
    expect(quotes.sortedQuoteCards.value.map(card => card.provider)).toEqual(['cow', 'other'])
  })

  it('re-fetches evicted CoW quotes when eligibility returns', async () => {
    const includeCowSwap = ref(true)
    const cowQuote = makeQuote('100', '300')
    const otherQuote = makeQuote('100', '200')
    getSwapProviders.mockImplementation(async ({ includeCowSwap: include }: { includeCowSwap?: boolean }) =>
      include ? ['cow', 'other'] : ['other'],
    )
    getSwapQuotes.mockImplementation(({ provider }: { provider: string }) =>
      Promise.resolve([provider === 'cow' ? cowQuote : otherQuote]),
    )

    const quotes = useSwapQuotesParallel({
      amountField: 'amountOut',
      compare: 'max',
      includeCowSwap: () => includeCowSwap.value,
    })

    await quotes.requestQuotes(requestParams)
    await flushPromises()
    await nextTick()
    expect(quotes.sortedQuoteCards.value.map(card => card.provider)).toEqual(['cow', 'other'])

    // Gate flips off (e.g. switch to a Safe): CoW cards evict.
    includeCowSwap.value = false
    await nextTick()
    expect(quotes.sortedQuoteCards.value.map(card => card.provider)).toEqual(['other'])

    // Gate returns (switch back to the EOA): eviction was one-way, so the
    // sweep replays to restore the CoW route.
    includeCowSwap.value = true
    await nextTick()
    await flushPromises()
    await nextTick()
    expect(quotes.sortedQuoteCards.value.map(card => card.provider)).toEqual(['cow', 'other'])
  })

  it('does not fetch when eligibility resolves before any sweep', async () => {
    const includeCowSwap = ref(false)
    getSwapProviders.mockResolvedValue(['cow', 'other'])

    useSwapQuotesParallel({
      amountField: 'amountOut',
      compare: 'max',
      includeCowSwap: () => includeCowSwap.value,
    })

    includeCowSwap.value = true
    await nextTick()
    await flushPromises()

    expect(getSwapProviders).not.toHaveBeenCalled()
  })
})
