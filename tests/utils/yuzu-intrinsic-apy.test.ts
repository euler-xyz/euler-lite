import { describe, expect, it } from 'vitest'
import {
  extractHyperbeatWeightedApr,
  extractValantisApy,
} from '~/utils/yuzu-intrinsic-apy'

describe('HyperEVM intrinsic APY helpers', () => {
  it('uses only active Hyperbeat delegations when computing weighted APR', () => {
    expect(extractHyperbeatWeightedApr({
      data: {
        delegations: [
          { status: 'active', apr: 2, amount: '100' },
          { status: 'active', apr: 5, amount: '300' },
          { status: 'inactive', apr: 99, amount: '900' },
        ],
      },
    })).toBe(4.25)
  })

  it('reads Valantis stHYPE APR from a raw numeric response', () => {
    expect(extractValantisApy('2.38')).toBe(2.38)
  })
})
