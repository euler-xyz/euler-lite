import { BPS_BASE } from '~/entities/tuning-constants'

// 0.5% safety margin subtracted from the raw multiplier (50 basis points)
const SAFETY_MARGIN_BPS = 50n

/**
 * Compute the maximum leverage multiplier for a given borrow LTV.
 * Raw formula: 1 / (1 - LTV), with a 0.5% safety margin deducted.
 *
 * @param borrowLTV - LTV in basis points (e.g. 9000n = 90%)
 * @returns max multiplier floored to 2 decimal places, minimum 1
 */
export const getMaxMultiplier = (borrowLTV: bigint | number): number => {
  const ltv = typeof borrowLTV === 'number'
    ? BigInt(Math.round(borrowLTV * 10_000))
    : borrowLTV || 0n
  if (ltv <= 0n || ltv >= BPS_BASE) {
    return 1
  }
  const result = (BPS_BASE * ltv) / (BPS_BASE - ltv) - SAFETY_MARGIN_BPS + BPS_BASE
  const value = Number(result) / 10000
  if (!Number.isFinite(value)) {
    return 1
  }
  return Math.max(1, Math.floor(value * 100) / 100)
}

/**
 * Compute the maximum Return on Equity for a leveraged position.
 * Formula: supplyApy + (multiplier - 1) * (supplyApy - borrowApy) + loopingRewardApr
 *
 * Looping rewards are added flat (not scaled by leverage) because they are
 * based on net liquidity which stays constant regardless of leverage.
 *
 * @param maxMultiplier - from getMaxMultiplier()
 * @param supplyApy - supply APY including rewards (%)
 * @param borrowApy - borrow APY including rewards (%)
 * @param loopingRewardApr - flat looping incentive APR (%), defaults to 0
 * @returns max ROE as a percentage
 */
export const getMaxRoe = (
  maxMultiplier: number,
  supplyApy: number,
  borrowApy: number,
  loopingRewardApr: number = 0,
): number => {
  const netApy = supplyApy - borrowApy
  if (
    !Number.isFinite(maxMultiplier)
    || !Number.isFinite(supplyApy)
    || !Number.isFinite(netApy)
    || !Number.isFinite(loopingRewardApr)
  ) {
    return 0
  }
  return supplyApy + (maxMultiplier - 1) * netApy + loopingRewardApr
}
