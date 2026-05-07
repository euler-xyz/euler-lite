import type { Vault, SecuritizeVault, VaultCollateralLTV } from './types'
import { getCurrentLiquidationLTV } from './ltv'

/**
 * A collateral pair with live borrow-side exposure to a vault. Matches the
 * fields rendered by the "Collateral exposure" overview block.
 */
export interface CollateralExposurePair {
  collateral: Vault | SecuritizeVault
  borrowLTV: bigint
  liquidationLTV: bigint
  initialLiquidationLTV: bigint
  targetTimestamp: bigint
  rampDuration: bigint
}

/**
 * Resolves a collateral vault by address. Returns `undefined` when the
 * collateral is unknown (not yet loaded in the vault registry).
 */
export type CollateralVaultResolver
  = (address: string) => Vault | SecuritizeVault | undefined

/**
 * Internal predicate: is this collateral/LTV combination "live" — i.e. does it
 * represent active or residual borrow-side exposure against the vault?
 *
 * A pair is live when:
 *  - the current liquidation LTV is still non-zero (i.e. not fully ramped
 *    down), AND
 *  - either the pair is currently borrowable (`borrowLTV > 0`) or the
 *    collateral vault has outstanding supply — meaning existing borrows can
 *    still accrue interest even after `borrowLTV` has been set to zero mid
 *    ramp-down.
 *
 * Note: `collateral.totalAssets > 0n` is an intentional over-approximation.
 * It checks whether the collateral vault has *any* deposits, not whether those
 * deposits are actively backing borrows on *this* vault. This errs on the side
 * of showing the IRM chart (false positive) rather than hiding it (false
 * negative), and matches the heuristic used by the original inline code.
 *
 * Distinct from {@link isLiveCollateralEdge} (in `./ltv`), which is the
 * edge-level predicate used by discovery views — it does not have access to
 * the collateral vault object, treats `borrowLTV > 0` as sufficient on its
 * own, and is intentionally broader.
 */
const isLiveExposure = (
  ltv: VaultCollateralLTV,
  collateral: Vault | SecuritizeVault,
  nowSeconds?: bigint,
): boolean => {
  if (getCurrentLiquidationLTV(ltv, nowSeconds) <= 0n) return false
  return ltv.borrowLTV > 0n || collateral.totalAssets > 0n
}

/**
 * Build the list of collateral pairs with live borrow-side exposure to a vault.
 * Returns them sorted by `borrowLTV` descending (currently borrowable first).
 *
 * See {@link isLiveExposure} for the liveness definition. Pairs whose
 * collateral is missing from the registry (resolver returns `undefined`) are
 * skipped.
 */
export const getCollateralExposurePairs = (
  vault: Pick<Vault, 'collateralLTVs'>,
  resolveCollateralVault: CollateralVaultResolver,
  nowSeconds?: bigint,
): CollateralExposurePair[] => {
  const pairs: CollateralExposurePair[] = []

  vault.collateralLTVs.forEach((ltv) => {
    const collateral = resolveCollateralVault(ltv.collateral)
    if (!collateral) return
    if (!isLiveExposure(ltv, collateral, nowSeconds)) return

    pairs.push({
      collateral,
      borrowLTV: ltv.borrowLTV,
      liquidationLTV: ltv.liquidationLTV,
      initialLiquidationLTV: ltv.initialLiquidationLTV,
      targetTimestamp: ltv.targetTimestamp,
      rampDuration: ltv.rampDuration,
    })
  })

  return pairs.sort((a, b) =>
    b.borrowLTV > a.borrowLTV ? 1 : b.borrowLTV < a.borrowLTV ? -1 : 0,
  )
}

/**
 * Predicate: does the vault have any live borrow-side collateral exposure?
 * Mirrors the filter used by {@link getCollateralExposurePairs} but
 * short-circuits on the first match.
 *
 * Use this to gate borrow-side UI (IRM chart, collateral-exposure block, etc.)
 * on vaults that either are currently borrowable or still carry outstanding
 * debt being wound down via a liquidation-LTV ramp.
 */
export const hasCollateralExposure = (
  vault: Pick<Vault, 'collateralLTVs'>,
  resolveCollateralVault: CollateralVaultResolver,
  nowSeconds?: bigint,
): boolean =>
  vault.collateralLTVs.some((ltv) => {
    const collateral = resolveCollateralVault(ltv.collateral)
    if (!collateral) return false
    return isLiveExposure(ltv, collateral, nowSeconds)
  })
