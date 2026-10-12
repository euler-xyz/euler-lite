import { ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import type { SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { makeSwapQuote } from '../reviewed-execution/swap-quote.test-fixture'
import { useSwapApi } from '~/composables/useSwapApi'
import { captureSwapReview } from '~/utils/swapReview'
import { SwapperMode } from '@eulerxyz/euler-v2-sdk'

const mocks = vi.hoisted(() => ({ getSdk: vi.fn() }))
vi.mock('~/composables/useEulerSdk', () => ({ getEulerSdkForChain: mocks.getSdk }))
afterEach(() => vi.unstubAllGlobals())

const setup = (quote: SwapQuote, decimalsIn: number, decimalsOut: number) => {
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  vi.stubGlobal('useWagmi', () => ({ address: ref(quote.receiver) }))
  vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false), spyAddress: ref(null) }))
  const fetchSwapQuotes = vi.fn(async () => [quote])
  const resolveTokenDecimals = vi.fn(async (_chainId: number, address: string) =>
    address.toLowerCase() === quote.tokenIn.address.toLowerCase() ? decimalsIn : decimalsOut,
  )
  mocks.getSdk.mockResolvedValue({ swapService: { fetchSwapQuotes }, tokenlistService: { resolveTokenDecimals } })
  return { api: useSwapApi(), fetchSwapQuotes, resolveTokenDecimals }
}

it('normalizes both quote tokens before route valuation and transaction review', async () => {
  const quote = makeSwapQuote()
  quote.amountIn = '100000000'
  quote.amountOut = '1250000'
  quote.tokenIn.decimals = 18
  quote.tokenOut.decimals = 18
  const { api } = setup(quote, 8, 6)
  const [normalized] = await api.getSwapQuotes({ tokenIn: quote.tokenIn.address, tokenOut: quote.tokenOut.address } as never)
  expect(normalized).toMatchObject({ tokenIn: { decimals: 8 }, tokenOut: { decimals: 6 }, amountIn: '100000000', amountOut: '1250000' })
  expect(captureSwapReview(normalized!, SwapperMode.EXACT_IN)).toMatchObject({ swapFromAmount: '1', swapToAmount: '1.25' })
  expect(quote.tokenIn.decimals).toBe(18)
})

it('keeps a CoW share-token quote in the share contract units', async () => {
  const quote = makeSwapQuote()
  quote.tokenIn.decimals = 6
  const { api } = setup(quote, 18, 8)
  const [normalized] = await api.getSwapQuotes({ tokenIn: quote.tokenIn.address, tokenOut: quote.tokenOut.address } as never)
  expect(normalized!.tokenIn.decimals).toBe(18)
})

it('does not expose a quote when either token cannot be verified', async () => {
  const quote = makeSwapQuote()
  const { api, resolveTokenDecimals } = setup(quote, 8, 6)
  resolveTokenDecimals.mockRejectedValue(new Error('RPC unavailable'))
  await expect(api.getSwapQuotes({ tokenIn: quote.tokenIn.address, tokenOut: quote.tokenOut.address } as never)).rejects.toThrow('RPC unavailable')
})
