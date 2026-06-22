import { describe, expect, it } from 'vitest'
import { getVisibleSwapRouteItems } from '~/utils/swapRouteVisibility'
import type { SwapRouteItem } from '~/utils/swapRouteItems'

const makeItem = (provider: string, isGasless = false): SwapRouteItem => ({
  provider,
  amount: '1',
  symbol: 'ETH',
  isGasless,
})

const providers = (items: SwapRouteItem[]) => items.map(item => item.provider)

describe('getVisibleSwapRouteItems', () => {
  const items = [
    makeItem('best'),
    makeItem('second'),
    makeItem('third'),
    makeItem('cow', true),
    makeItem('fifth'),
  ]

  it('keeps sorted collapsed order when gasless promotion is disabled', () => {
    expect(providers(getVisibleSwapRouteItems(items, {
      expanded: false,
      promoteGasless: false,
    }))).toEqual(['best', 'second', 'third'])
  })

  it('promotes a below-cutoff gasless route to the third collapsed slot when enabled', () => {
    expect(providers(getVisibleSwapRouteItems(items, {
      expanded: false,
      promoteGasless: true,
    }))).toEqual(['best', 'second', 'cow'])
  })

  it('keeps a gasless route in its sorted position when it is already visible', () => {
    const alreadyVisible = [
      makeItem('best'),
      makeItem('cow', true),
      makeItem('third'),
      makeItem('fourth'),
    ]

    expect(providers(getVisibleSwapRouteItems(alreadyVisible, {
      expanded: false,
      promoteGasless: true,
    }))).toEqual(['best', 'cow', 'third'])
  })

  it('keeps full sorted order when expanded', () => {
    expect(providers(getVisibleSwapRouteItems(items, {
      expanded: true,
      promoteGasless: true,
    }))).toEqual(['best', 'second', 'third', 'cow', 'fifth'])
  })
})
