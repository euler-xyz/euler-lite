interface SuppliedPositionLike {
  assets: bigint
  shares: bigint
  suppliedValueUsd?: number
}

interface BorrowPositionLike {
  borrowed: bigint
  borrow: { borrowedValueUsd?: number }
  collaterals: readonly SuppliedPositionLike[]
}

export interface PortfolioPricingGaps {
  supplied: boolean
  borrowed: boolean
}

const isUnpriced = (value: number | undefined) => value === undefined || !Number.isFinite(value)

const isUnpricedSupply = (position: SuppliedPositionLike) =>
  (position.assets > 0n || position.shares > 0n) && isUnpriced(position.suppliedValueUsd)

// SDK portfolio totals sum only priced positions, so a partial total looks
// complete; these flags cover the positions those totals include.
export const portfolioPricingGaps = (
  savings: readonly SuppliedPositionLike[],
  borrows: readonly BorrowPositionLike[],
): PortfolioPricingGaps => {
  const openBorrows = borrows.filter(position => position.borrowed > 0n)
  return {
    supplied: savings.some(isUnpricedSupply)
      || openBorrows.some(position => position.collaterals.some(isUnpricedSupply)),
    borrowed: openBorrows.some(position => isUnpriced(position.borrow.borrowedValueUsd)),
  }
}
