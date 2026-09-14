import { describe, expect, it } from 'vitest'
import type { SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { isCowProviderOrQuote } from '~/entities/cowswap'

const quoteWithRouteProvider = (providerName: string): SwapQuote => ({
  route: [{ providerName }],
}) as SwapQuote

describe('isCowProviderOrQuote', () => {
  it('detects a CoW route when the quote card provider is not CoW', () => {
    expect(isCowProviderOrQuote('router', quoteWithRouteProvider('cow'))).toBe(true)
  })

  it('does not classify a non-CoW provider and route as CoW', () => {
    expect(isCowProviderOrQuote('router', quoteWithRouteProvider('other'))).toBe(false)
  })
})
