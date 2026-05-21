import { getMaxMultiplier as sdkGetMaxMultiplier, getMaxRoe as sdkGetMaxRoe } from '@eulerxyz/euler-v2-sdk'

/**
 * Compute the maximum leverage multiplier for a given borrow LTV.
 * Accepts either decimal (0.85) or basis points (8500n).
 *
 * @param borrowLTV - LTV in basis points (bigint, e.g. 9000n = 90%) or decimal (number, e.g. 0.9)
 * @returns max multiplier floored to 2 decimal places, minimum 1
 */
export const getMaxMultiplier = (borrowLTV: bigint | number): number => {
  const ltv = typeof borrowLTV === 'bigint'
    ? Number(borrowLTV) / 10_000
    : borrowLTV
  if (!Number.isFinite(ltv) || ltv <= 0 || ltv >= 1) return 1
  return sdkGetMaxMultiplier(ltv)
}

/**
 * Compute the maximum Return on Equity for a leveraged position.
 *
 * `sdkGetMaxRoe(M, S, B) = S + (M - 1) * (S - B)`. Looping rewards are paid
 * per unit of equity (not scaled by leverage), so they're added flat.
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
  if (
    !Number.isFinite(maxMultiplier)
    || !Number.isFinite(supplyApy)
    || !Number.isFinite(borrowApy)
    || !Number.isFinite(loopingRewardApr)
  ) {
    return 0
  }
  return sdkGetMaxRoe(maxMultiplier, supplyApy, borrowApy) + loopingRewardApr
}
