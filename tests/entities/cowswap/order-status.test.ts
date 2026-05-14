import { describe, expect, it } from 'vitest'
import { resolveCowSwapOrderStatusType } from '~/entities/cowswap/order-status'

describe('resolveCowSwapOrderStatusType', () => {
  it('prefers a traded competition status over a cancelled lifecycle status', () => {
    expect(resolveCowSwapOrderStatusType({
      competitionType: 'traded',
      orderType: 'cancelled',
    })).toBe('traded')
  })

  it('uses fulfilled when the lifecycle order status is fulfilled', () => {
    expect(resolveCowSwapOrderStatusType({
      competitionType: 'cancelled',
      orderType: 'fulfilled',
    })).toBe('fulfilled')
  })
})
