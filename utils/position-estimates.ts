import { nanoToValue } from '~/utils/crypto-utils'
import type { AccountBorrowPosition } from '~/entities/account'
import { getAssetOraclePrice, getCollateralOraclePrice, conservativePriceRatioNumber } from '~/services/pricing/priceProvider'
import type { EVault, SecuritizeCollateralVault } from '~/entities/vault'

/**
 * Derives the total collateral value (in borrow-asset terms) from the position's
 * on-chain userLTV and borrowed amount. This accounts for ALL collaterals, not
 * just the primary one.
 *
 * Returns null if the position has no borrow or LTV is zero.
 */
export function getTotalCollateralValue(position: AccountBorrowPosition): number | null {
  const borrowed = nanoToValue(position.borrowed, position.borrow.shares.decimals || 18)
  const userLtv = nanoToValue(position.userLTV, 18)
  if (userLtv <= 0 || borrowed <= 0) return null
  return borrowed / userLtv * 100
}

/**
 * Gets the conservative price ratio for a single collateral relative to a borrow vault.
 * Returns the value of 1 unit of collateral in borrow-asset terms.
 */
export function getCollateralPriceRatio(
  borrowVault: EVault,
  collateralVault: EVault | SecuritizeCollateralVault,
): number | null {
  const collateralPrice = getCollateralOraclePrice(borrowVault, collateralVault)
  const borrowPrice = getAssetOraclePrice(borrowVault)
  return conservativePriceRatioNumber(collateralPrice, borrowPrice)
}

interface EstimateParams {
  position: AccountBorrowPosition
  /** Change in collateral amount (in collateral asset units). Positive = supply, negative = withdraw. */
  collateralDelta?: number
  /** Change in borrow amount (in borrow asset units). Positive = borrow more, negative = repay. */
  borrowDelta?: number
  /** Price ratio for the collateral being changed (from getCollateralPriceRatio). Only needed if collateralDelta != 0. */
  collateralPriceRatio?: number | null
}

export interface PositionEstimate {
  newLtv: number
  newHealth: number
  newLiquidationPrice: number | null
}

/**
 * Estimates new LTV, health score, and liquidation price after a position change.
 * Uses the on-chain userLTV to derive total collateral value (multi-collateral aware),
 * then adjusts for the specific operation.
 */
export function estimatePositionAfterChange(params: EstimateParams): PositionEstimate | null {
  const { position, collateralDelta = 0, borrowDelta = 0, collateralPriceRatio } = params

  const totalCollateralValue = getTotalCollateralValue(position)
  if (totalCollateralValue === null) return null

  const borrowed = nanoToValue(position.borrowed, position.borrow.shares.decimals || 18)
  const liquidationLtv = Number(position.liquidationLTV) / 100

  // Adjust collateral value
  let newCollateralValue = totalCollateralValue
  if (collateralDelta !== 0 && collateralPriceRatio) {
    newCollateralValue += collateralDelta * collateralPriceRatio
  }

  // Adjust borrowed amount
  const newBorrowed = borrowed + borrowDelta

  if (newCollateralValue <= 0 || newBorrowed <= 0) {
    return { newLtv: 0, newHealth: Infinity, newLiquidationPrice: null }
  }

  const newLtv = (newBorrowed / newCollateralValue) * 100
  const newHealth = newLtv > 0 ? liquidationLtv / newLtv : Infinity

  // Liquidation price: derived from the oracle price and health
  // liqPrice = oraclePrice / health
  const oraclePrice = collateralPriceRatio
  const newLiquidationPrice = oraclePrice && newHealth >= 1 && newHealth < Infinity
    ? oraclePrice / newHealth
    : null

  return { newLtv, newHealth, newLiquidationPrice }
}
