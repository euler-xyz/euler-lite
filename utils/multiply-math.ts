import { getMaxMultiplier as sdkGetMaxMultiplier } from '@eulerxyz/euler-v2-sdk'

/**
 * Pure math functions for the multiply/leverage form.
 * Extracted from composables/borrow/useMultiplyForm.ts for testability.
 */

export interface LeverageDebtParams {
  /** Supplied collateral amount in native decimals */
  suppliedCollateral: bigint
  /** Collateral price (bid or mid) from oracle */
  collateralOutBid: bigint
  /** Collateral amountIn from oracle (denominator for price) */
  collateralAmountIn: bigint
  /** Leverage multiplier (e.g. 2.0 = 2x leverage) */
  multiplier: number
  /** Liability amountIn from oracle */
  liabilityIn: bigint
  /** Liability price (ask or mid) from oracle */
  liabilityOutAsk: bigint
}

/**
 * Calculate the debt amount needed for a leveraged position.
 *
 * Formula: converts supplied collateral to a value using oracle prices,
 * applies the multiplier, then converts the extra debt portion back
 * to liability tokens using the liability oracle price.
 */
export const computeLeverageDebt = (params: LeverageDebtParams): bigint => {
  const {
    suppliedCollateral,
    collateralOutBid,
    collateralAmountIn,
    multiplier,
    liabilityIn,
    liabilityOutAsk,
  } = params

  if (collateralAmountIn <= 0n || liabilityOutAsk <= 0n) return 0n

  const suppliedCollateralValue = (suppliedCollateral * collateralOutBid) / collateralAmountIn
  if (!suppliedCollateralValue) return 0n

  const scaledMultiple = BigInt(Math.floor(multiplier * 1000))
  if (scaledMultiple <= 1000n) return 0n

  const multipliedCollateral = (suppliedCollateralValue * scaledMultiple) / 1000n
  if (multipliedCollateral <= suppliedCollateralValue) return 0n

  const totalDebtValue = multipliedCollateral - suppliedCollateralValue
  return (totalDebtValue * liabilityIn) / liabilityOutAsk
}

/**
 * Calculate the maximum leverage multiplier from a borrow LTV percentage.
 *
 * Uses the SDK's safety margin and flooring logic.
 * Returns 1 (no leverage) for invalid or extreme LTV values.
 */
export const computeMaxMultiplier = (ltvPercent: number): number => {
  if (!ltvPercent || !Number.isFinite(ltvPercent)) return 1
  const ltv = ltvPercent / 100
  if (ltv <= 0 || ltv >= 0.99) return 1
  return sdkGetMaxMultiplier(ltv)
}

/**
 * Calculate the minimum multiplier. Returns 0 if no leverage is possible, 1 otherwise.
 */
export const computeMinMultiplier = (maxMultiplier: number): number => {
  return maxMultiplier <= 1 ? 0 : 1
}

/**
 * Calculate weighted supply APY across supply and long vaults.
 *
 * When a long vault is present, the APY is weighted by the USD value
 * in each vault. Returns the supply APY alone if no long vault.
 */
export const computeWeightedSupplyApy = (
  supplyUsd: number,
  supplyApy: number,
  longUsd: number | null,
  longApy: number | null,
): number | null => {
  if (!longUsd || longUsd <= 0 || longApy === null) return supplyApy
  const total = supplyUsd + longUsd
  if (!Number.isFinite(total) || total <= 0) return null
  return (supplyUsd * supplyApy + longUsd * longApy) / total
}
