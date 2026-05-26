import type { EVaultCollateral } from '@eulerxyz/euler-v2-sdk'

/**
 * Is this collateral edge still "live" from the protocol's perspective?
 *
 * True if either:
 * - the edge accepts new borrows (`borrowLTV > 0`), or
 * - the current liquidation LTV is still > 0, including during an active
 *   ramp-down for positions opened before the ramp.
 *
 * Use this everywhere the UI asks "should this collateral relationship be visible
 * / loaded / counted?". An LTV ramp-down sets borrow LTV to 0 immediately while
 * liquidation LTV ramps over time, so a `borrowLTV > 0` check alone drops live
 * mid-ramp edges from discovery.
 *
 * This is the edge-level predicate. For borrow-side exposure displays, also
 * check collateral vault balances so empty collateral vaults do not render as
 * active exposure.
 */
export const isLiveCollateralEdge = (ltv: EVaultCollateral): boolean =>
  ltv.borrowLTV > 0 || ltv.currentLiquidationLTV > 0
