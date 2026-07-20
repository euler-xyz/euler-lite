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

export interface BorrowMoreRiskPosition {
  userLTV?: bigint
  currentLTV?: bigint
}

export const getBorrowMorePositionLtv = (
  position: BorrowMoreRiskPosition,
): bigint | undefined => position.userLTV ?? position.currentLTV

export const getBorrowMorePositionIdentityKey = ({
  chainId,
  account,
  subAccount,
  collateralVaultAddress,
  borrowVaultAddress,
}: {
  chainId: number | undefined
  account: string | undefined
  subAccount: string
  collateralVaultAddress: string | undefined
  borrowVaultAddress: string | undefined
}): string => [
  chainId ?? '',
  account ?? '',
  subAccount,
  collateralVaultAddress ?? '',
  borrowVaultAddress ?? '',
].map(value => value.toString().toLowerCase()).join(':')

export const getBorrowMoreProjectedLtv = ({
  borrowed,
  borrowDecimals,
  additionalBorrowAmount,
  totalCollateral,
}: {
  borrowed: bigint
  borrowDecimals: Decimals
  additionalBorrowAmount: string
  totalCollateral: number
}): number | undefined => {
  if (!Number.isFinite(totalCollateral) || totalCollateral <= 0) return undefined

  const totalBorrow = nanoToValue(borrowed, borrowDecimals) + (+additionalBorrowAmount || 0)
  return +((totalBorrow / totalCollateral) * 100).toFixed(2)
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
