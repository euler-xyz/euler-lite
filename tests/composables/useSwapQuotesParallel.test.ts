import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, ref, watch } from 'vue'
import type { SwapApiQuote } from '~/entities/swap'
import { useSwapQuotesParallel } from '~/composables/useSwapQuotesParallel'

const makeQuote = (amountIn: string, amountOut: string): SwapApiQuote =>
  ({ amountIn, amountOut }) as SwapApiQuote

const requestParams = {
  tokenIn: '0x0000000000000000000000000000000000000001',
  tokenOut: '0x0000000000000000000000000000000000000002',
  accountIn: '0x0000000000000000000000000000000000000003',
  accountOut: '0x0000000000000000000000000000000000000004',
  amount: 100n,
  vaultIn: '0x0000000000000000000000000000000000000005',
  receiver: '0x0000000000000000000000000000000000000006',
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
  })

  it('keeps effectiveQuote stable when selecting the current best provider', async () => {
    const firstQuote = makeQuote('100', '200')
    getSwapProviders.mockResolvedValue(['first'])
    getSwapQuotes.mockResolvedValue([firstQuote])

    const quotes = useSwapQuotesParallel({ amountField: 'amountOut', compare: 'max' })
    await quotes.requestQuotes(requestParams)
    await flushPromises()
    await nextTick()

    const changes: Array<SwapApiQuote | null> = []
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

    const changes: Array<SwapApiQuote | null> = []
    watch(quotes.effectiveQuote, quote => changes.push(quote))

    quotes.selectProvider('other')
    await nextTick()

    expect(quotes.selectedProvider.value).toBe('other')
    expect(quotes.effectiveQuote.value?.amountOut).toBe('200')
    expect(changes).toHaveLength(1)
  })
})
