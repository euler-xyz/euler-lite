import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type Ref } from 'vue'
import type { EVault, SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { useSwapPriceImpact } from '~/composables/useSwapPriceImpact'
import * as prices from '~/utils/sdk-prices'

const tokenIn = { address: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', decimals: 6, symbol: 'AUSD' }
const tokenOut = { address: '0x9FC74f8Ed616B5BaF52a170caa97d6d3898602d1', decimals: 6, symbol: 'PT-AUSD-8OCT2026' }
const makeQuote = (amountOut: string): SwapQuote => ({
  tokenIn,
  tokenOut,
  amountIn: '9501337119',
  amountOut,
}) as SwapQuote

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  vi.restoreAllMocks()
})

const setup = (initialQuote: SwapQuote | null = makeQuote('118')) => {
  const scope = effectScope()
  scopes.push(scope)
  const quote = ref(initialQuote)
  const fromVault = ref({ asset: tokenIn, marketPriceUsd: 0.99988 } as EVault) as Ref<EVault>
  const toVault = ref({ asset: tokenOut, marketPriceUsd: 0.9960379 } as EVault) as Ref<EVault>
  const result = scope.run(() => useSwapPriceImpact({ quote, fromVault, toVault }))!
  return { ...result, quote, fromVault, toVault }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await nextTick()
  }
}

const expectedImpact = (amountOut: string, outputPrice = 0.9960379) =>
  (Number(amountOut) * outputPrice / (9501337119 * 0.99988) - 1) * 100

const deferred = () => {
  let resolve!: (value: number) => void
  const promise = new Promise<number>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('useSwapPriceImpact', () => {
  it('recalculates when a dust quote is replaced by a better quote with the same input', async () => {
    const { quote, priceImpact } = setup()
    await flush()
    expect(priceImpact.value).toBeCloseTo(-100, 4)

    quote.value = makeQuote('9537016792')
    await flush()
    expect(priceImpact.value).toBeCloseTo(expectedImpact('9537016792'), 10)
    expect(Math.abs(priceImpact.value!)).toBeLessThan(0.1)

    // Selecting the poor provider must restore its actual large price impact.
    quote.value = makeQuote('118')
    await flush()
    expect(priceImpact.value).toBeCloseTo(-100, 4)
  })

  it('recalculates when the output vault market price changes', async () => {
    const { toVault, priceImpact } = setup(makeQuote('9537016792'))
    await flush()
    toVault.value.marketPriceUsd = 0.9
    await flush()
    expect(priceImpact.value).toBeCloseTo(expectedImpact('9537016792', 0.9), 10)
  })

  it.each([null, makeQuote('0')])('does not restore an old impact after the quote becomes unusable: %j', async (nextQuote) => {
    const pending = deferred()
    vi.spyOn(prices, 'getTokenUsdValue')
      .mockResolvedValueOnce(100)
      .mockReturnValueOnce(pending.promise)
    const { quote, priceImpact } = setup()
    await nextTick()
    quote.value = nextQuote
    await flush()
    pending.resolve(90)
    await flush()
    expect(priceImpact.value).toBeNull()
  })

  it('ignores a previous quote valuation that finishes after the current quote', async () => {
    const pending = deferred()
    vi.spyOn(prices, 'getTokenUsdValue')
      .mockResolvedValueOnce(100)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(99)
    const { quote, priceImpact } = setup()
    await nextTick()
    quote.value = makeQuote('9537016792')
    await flush()
    expect(priceImpact.value).toBeCloseTo(-1)
    pending.resolve(0.000118)
    await flush()
    expect(priceImpact.value).toBeCloseTo(-1)
  })
})
