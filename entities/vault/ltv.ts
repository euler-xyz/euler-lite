import type { VaultCollateralLTV } from './types'

/** Shared LTV ramp config fields used by both VaultCollateralLTV and BorrowVaultPair */
export type LTVRampConfig = Pick<VaultCollateralLTV, 'liquidationLTV' | 'initialLiquidationLTV' | 'targetTimestamp' | 'rampDuration'>

/** A collateral edge with both borrow side and liquidation-ramp config — covers VaultCollateralLTV. */
export type CollateralEdgeConfig = LTVRampConfig & Pick<VaultCollateralLTV, 'borrowLTV'>

/**
 * Calculate the current liquidation LTV, taking into account ramping.
 * When liquidation LTV is lowered, it ramps down linearly from initialLiquidationLTV
 * to liquidationLTV (target) over rampDuration, reaching target at targetTimestamp.
 *
 * @param nowSeconds - Optional override for current time (seconds since epoch). Defaults to Date.now().
 */
export const getCurrentLiquidationLTV = (ltv: LTVRampConfig, nowSeconds?: bigint): bigint => {
  const now = nowSeconds ?? BigInt(Math.floor(Date.now() / 1000))

  // If ramping is complete or LTV is ramping UP (not down), return target
  if (now >= ltv.targetTimestamp || ltv.liquidationLTV >= ltv.initialLiquidationLTV) {
    return ltv.liquidationLTV
  }

  // Calculate interpolated value during ramp down
  const timeRemaining = ltv.targetTimestamp - now
  const currentLTV = ltv.liquidationLTV
    + ((ltv.initialLiquidationLTV - ltv.liquidationLTV) * timeRemaining) / ltv.rampDuration

  // Cap at initialLiquidationLTV to prevent overshoot before ramp period starts
  return currentLTV > ltv.initialLiquidationLTV ? ltv.initialLiquidationLTV : currentLTV
}

/**
 * Check if the liquidation LTV is currently ramping down
 *
 * @param nowSeconds - Optional override for current time (seconds since epoch). Defaults to Date.now().
 */
export const isLiquidationLTVRamping = (ltv: LTVRampConfig, nowSeconds?: bigint): boolean => {
  const now = nowSeconds ?? BigInt(Math.floor(Date.now() / 1000))

  // Ramping down if: not yet at target timestamp AND target is less than initial (ramping DOWN)
  return now < ltv.targetTimestamp && ltv.liquidationLTV < ltv.initialLiquidationLTV
}

/**
 * Is this collateral edge still "live" from the protocol's perspective?
 *
 * True if either:
 * - the edge accepts new borrows (borrowLTV > 0), or
 * - the current (interpolated) liquidation LTV is still > 0 — i.e. positions
 *   opened before the ramp are still being wound down rather than fully closed.
 *
 * Use this everywhere the UI asks "should this collateral relationship be visible
 * / loaded / counted?". An LTV ramp-down sets borrowLTV to 0 immediately while
 * liquidation LTV ramps over time, so a `borrowLTV > 0` check alone drops live
 * mid-ramp edges (escrows, etc.) from discovery.
 */
export const isLiveCollateralEdge = (ltv: CollateralEdgeConfig, nowSeconds?: bigint): boolean =>
  ltv.borrowLTV > 0n || getCurrentLiquidationLTV(ltv, nowSeconds) > 0n

/**
 * Get the time remaining until ramping completes (in seconds)
 *
 * @param nowSeconds - Optional override for current time (seconds since epoch). Defaults to Date.now().
 */
export const getRampTimeRemaining = (ltv: LTVRampConfig, nowSeconds?: bigint): bigint => {
  const now = nowSeconds ?? BigInt(Math.floor(Date.now() / 1000))
  if (now >= ltv.targetTimestamp) {
    return 0n
  }
  return ltv.targetTimestamp - now
}
