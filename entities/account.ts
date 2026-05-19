import type { EVault, EVaultCollateralRamping, IHasVaultAddress, PortfolioBorrowPosition } from '@eulerxyz/euler-v2-sdk'

const WAD = 10n ** 18n
const BPS = 10000n

/** Linear-ramp inputs sufficient to project a forced-liquidation time. */
export interface PositionRampInput {
  /** Current user LTV, WAD-scaled (e.g. 60% = 0.6 * 1e18). */
  userLTV: bigint
  /** Post-ramp liquidation LTV target, as a decimal fraction (e.g. 0.8 = 80%). */
  liquidationLTV: number
  /** Ramp config — absent when the edge is not ramping. */
  ramping?: EVaultCollateralRamping
}

export interface PositionRampStatus {
  isRamping: boolean
  /** True when the user's LTV would cross the effective LLTV before the ramp ends. */
  willBeLiquidated: boolean
  /** Unix seconds at which the effective LLTV crosses below `userLTV`. `null` when not in danger. */
  forcedLiquidationAt: bigint | null
}

const toBpsFromDecimal = (decimal: number): bigint =>
  BigInt(Math.round(decimal * Number(BPS)))

const toBpsFromWad = (wad: bigint): bigint =>
  (wad * BPS) / WAD

const isRamping = (
  ramping: EVaultCollateralRamping | undefined,
  liquidationLTVdec: number,
  nowSeconds: bigint,
): boolean => {
  if (!ramping || ramping.rampDuration <= 0n) return false
  if (BigInt(ramping.targetTimestamp) <= nowSeconds) return false
  // Ramp DOWN only — target is strictly below initial.
  return liquidationLTVdec < ramping.initialLiquidationLTV
}

/**
 * Project when (if ever) the user's position would become liquidatable while
 * the ramp is in progress, assuming `userLTV` stays constant.
 *
 * Linear interpolation between `initialLiquidationLTV` and `liquidationLTV`
 * over `[targetTimestamp - rampDuration, targetTimestamp]`. Returns
 * `forcedLiquidationAt = targetTimestamp` when the crossing only happens at
 * ramp end. Returns an earlier-than-now timestamp when `userLTV` is already
 * past the current effective LLTV — callers should treat that as "now".
 */
export const getRampStatus = (
  input: PositionRampInput,
  nowSeconds?: bigint,
): PositionRampStatus => {
  const now = nowSeconds ?? BigInt(Math.floor(Date.now() / 1000))
  const ramping = input.ramping
  if (!isRamping(ramping, input.liquidationLTV, now)) {
    return { isRamping: false, willBeLiquidated: false, forcedLiquidationAt: null }
  }

  // Work in BPS bigints. SDK exposes liquidationLTV/initialLiquidationLTV as
  // decimal numbers; userLTV is WAD bigint.
  const userLTVbps = toBpsFromWad(input.userLTV)
  const targetLLTVbps = toBpsFromDecimal(input.liquidationLTV)
  const initialLLTVbps = toBpsFromDecimal(ramping!.initialLiquidationLTV)

  if (userLTVbps < targetLLTVbps) {
    return { isRamping: true, willBeLiquidated: false, forcedLiquidationAt: null }
  }

  if (initialLLTVbps <= targetLLTVbps) {
    // Degenerate ramp (no actual decrease); treat as not in danger.
    return { isRamping: true, willBeLiquidated: false, forcedLiquidationAt: null }
  }

  // currentEffectiveLLTV(t) = targetLLTV + (initialLLTV - targetLLTV) * (targetTimestamp - t) / rampDuration
  // Solve for t when currentEffectiveLLTV(t) == userLTV:
  //   t* = targetTimestamp - (userLTV - targetLLTV) * rampDuration / (initialLLTV - targetLLTV)
  const numerator = (userLTVbps - targetLLTVbps) * ramping!.rampDuration
  const denominator = initialLLTVbps - targetLLTVbps
  const offset = numerator / denominator
  const forcedLiquidationAt = BigInt(ramping!.targetTimestamp) - offset

  return { isRamping: true, willBeLiquidated: true, forcedLiquidationAt }
}

/** Find the borrow-vault collateral edge matching a portfolio position's primary collateral. */
const findCollateralEdge = (
  borrowVault: EVault | undefined,
  collateralAddress: string | undefined,
) => {
  if (!borrowVault?.collaterals || !collateralAddress) return undefined
  const lower = collateralAddress.toLowerCase()
  return borrowVault.collaterals.find(c => c.address.toLowerCase() === lower)
}

/**
 * Convenience wrapper: resolve the primary collateral edge for a borrow
 * position and project its ramp status. Returns a non-ramping status when the
 * collateral edge isn't found or doesn't ramp.
 */
export const getPositionRampStatus = (
  position: PortfolioBorrowPosition<IHasVaultAddress>,
  nowSeconds?: bigint,
): PositionRampStatus => {
  if (position.userLTV === undefined) {
    return { isRamping: false, willBeLiquidated: false, forcedLiquidationAt: null }
  }
  const edge = findCollateralEdge(
    position.borrowVault as EVault | undefined,
    position.collateralVault?.address,
  )
  if (!edge) {
    return { isRamping: false, willBeLiquidated: false, forcedLiquidationAt: null }
  }
  return getRampStatus({
    userLTV: position.userLTV,
    liquidationLTV: edge.liquidationLTV,
    ramping: edge.ramping,
  }, nowSeconds)
}

/** True when the primary collateral edge of a borrow position is currently ramping down. */
export const isPositionLiquidationLTVRamping = (
  position: PortfolioBorrowPosition<IHasVaultAddress>,
  nowSeconds?: bigint,
): boolean => {
  const edge = findCollateralEdge(
    position.borrowVault as EVault | undefined,
    position.collateralVault?.address,
  )
  if (!edge) return false
  const now = nowSeconds ?? BigInt(Math.floor(Date.now() / 1000))
  return isRamping(edge.ramping, edge.liquidationLTV, now)
}

/**
 * Return the ramp's target timestamp (post-ramp completion time, unix seconds)
 * for the primary collateral edge of a borrow position, or `null` when not
 * ramping.
 */
export const getPositionRampTargetTimestamp = (
  position: PortfolioBorrowPosition<IHasVaultAddress>,
): bigint | null => {
  const edge = findCollateralEdge(
    position.borrowVault as EVault | undefined,
    position.collateralVault?.address,
  )
  if (!edge?.ramping) return null
  return BigInt(edge.ramping.targetTimestamp)
}
