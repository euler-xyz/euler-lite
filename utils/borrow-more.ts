import { formatUnits } from 'viem'
import { ltvToPercent, nanoToValue, valueToNano } from '~/utils/crypto-utils'
import { FixedPoint } from '~/utils/fixed-point'
import { formatExactAmount, formatSmartAmount, trimTrailingZeros } from '~/utils/string-utils'

type Decimals = number | bigint

export interface BorrowMoreLiquidityVault {
  availableLiquidity?: bigint
  asset: {
    decimals: Decimals
    symbol: string
  }
}

export interface BorrowMoreAvailableLiquidityDisplay {
  exact: string
  display: string
}

export const getBorrowMoreAvailableLiquidityDisplay = (
  vault: BorrowMoreLiquidityVault | undefined,
): BorrowMoreAvailableLiquidityDisplay | null => {
  if (!vault || vault.availableLiquidity === undefined) return null

  return {
    exact: formatExactAmount(vault.availableLiquidity, vault.asset.decimals, vault.asset.symbol),
    display: `${formatSmartAmount(nanoToValue(vault.availableLiquidity, vault.asset.decimals))} ${vault.asset.symbol}`,
  }
}

export const getBorrowMoreLtvHeadroomAmount = ({
  borrowed,
  borrowDecimals,
  assetDecimals,
  currentLtvPercent,
  maxBorrowLtv,
}: {
  borrowed: bigint
  borrowDecimals: Decimals
  assetDecimals: Decimals
  currentLtvPercent: number
  maxBorrowLtv: bigint | number
}): bigint => {
  if (borrowed === 0n || currentLtvPercent <= 0) return 0n

  const maxLtvFP = FixedPoint.fromValue(valueToNano(ltvToPercent(maxBorrowLtv), 4), 4)
    .sub(FixedPoint.fromValue(100n, 4))
  const currentLtvFP = FixedPoint.fromValue(valueToNano(currentLtvPercent, 4), 4)
  if (currentLtvFP.isZero() || maxLtvFP.lte(currentLtvFP)) return 0n

  const borrowedFP = FixedPoint.fromValue(borrowed, Number(borrowDecimals))
  const additional = borrowedFP.mul(maxLtvFP.subUnsafe(currentLtvFP)).div(currentLtvFP)
  if (additional.isZero() || additional.isNegative()) return 0n
  return additional.toFormat({ decimals: Number(assetDecimals) }).value
}

export const getBorrowMoreMaxBorrowAmount = ({
  availableLiquidity,
  ltvHeadroom,
}: {
  availableLiquidity: bigint | undefined
  ltvHeadroom: bigint | undefined
}): bigint | undefined => {
  if (availableLiquidity === undefined || ltvHeadroom === undefined) return undefined
  return availableLiquidity < ltvHeadroom ? availableLiquidity : ltvHeadroom
}

export const formatBorrowMoreInputAmount = (amount: bigint, decimals: Decimals): string =>
  trimTrailingZeros(formatUnits(amount, Number(decimals)))
