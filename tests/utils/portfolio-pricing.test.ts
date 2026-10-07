import { describe, expect, it } from 'vitest'
import { portfolioPricingGaps } from '~/utils/portfolio-pricing'

const saving = (suppliedValueUsd: number | undefined, assets = 10n, shares = 10n) => ({
  assets,
  shares,
  suppliedValueUsd,
})

const borrow = (
  borrowedValueUsd: number | undefined,
  collaterals: ReturnType<typeof saving>[] = [saving(100)],
  borrowed = 5n,
) => ({
  borrowed,
  borrow: { borrowedValueUsd },
  collaterals,
})

describe('portfolioPricingGaps', () => {
  it('reports no gap when every position in view is priced', () => {
    expect(portfolioPricingGaps([saving(10), saving(0)], [borrow(50)])).toEqual({
      supplied: false,
      borrowed: false,
    })
  })

  it('flags supplied pricing when any one savings position is unpriced', () => {
    expect(portfolioPricingGaps([saving(10), saving(undefined)], [])).toEqual({
      supplied: true,
      borrowed: false,
    })
  })

  it('flags supplied pricing when a borrow position collateral is unpriced', () => {
    expect(portfolioPricingGaps([], [borrow(50, [saving(100), saving(undefined)])])).toEqual({
      supplied: true,
      borrowed: false,
    })
  })

  it('flags borrowed pricing when any debt is unpriced', () => {
    expect(portfolioPricingGaps([], [borrow(50), borrow(undefined)])).toEqual({
      supplied: false,
      borrowed: true,
    })
  })

  it('ignores empty balances and repaid debt', () => {
    expect(portfolioPricingGaps(
      [saving(undefined, 0n, 0n)],
      [borrow(undefined, [saving(undefined, 0n, 0n)], 0n)],
    )).toEqual({ supplied: false, borrowed: false })
  })

  it('treats a non-finite value as unpriced', () => {
    expect(portfolioPricingGaps([saving(Number.NaN)], [])).toEqual({
      supplied: true,
      borrowed: false,
    })
  })
})
