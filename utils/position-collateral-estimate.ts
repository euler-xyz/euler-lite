import type { EVault, EVaultCollateral, IAccountLiquidity, IHasVaultAddress, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { maxUint256 } from 'viem'
import { getPositionCollateralEdge } from '~/entities/account'
import { decimalLtvToBps } from '~/utils/ltv'
import { isLiveCollateralEdge } from '~/utils/vault/ltv'

const WAD = 10n ** 18n
const BPS = 10_000n

type Liquidity = Pick<IAccountLiquidity<IHasVaultAddress>, 'liabilityValue' | 'totalCollateralValue' | 'collaterals'>

export interface CollateralLiquidityEstimate {
  userLTV: bigint | null
  healthFactor: bigint
  hasLiquidationLiquidity: boolean
}

const currentLiquidationLtvBps = (edge: EVaultCollateral): bigint | null => {
  if (!Number.isFinite(edge.currentLiquidationLTV) || edge.currentLiquidationLTV < 0 || edge.currentLiquidationLTV > 1) return null
  if (!edge.isLiquidationLTVRamping) return decimalLtvToBps(edge.currentLiquidationLTV)
  const ramp = edge.ramping
  if (!ramp || ramp.rampDuration <= 0n || edge.rampTimeRemaining < 0n || edge.rampTimeRemaining > ramp.rampDuration) return null
  const target = decimalLtvToBps(edge.liquidationLTV)
  const initial = decimalLtvToBps(ramp.initialLiquidationLTV)
  // EVK floors the ramp interpolation in basis points at the vault snapshot time.
  return target + (initial - target) * edge.rampTimeRemaining / ramp.rampDuration
}

/** Project one collateral in the controller's oracle units, preserving every other collateral. */
export const estimateCollateralLiquidityChange = ({
  liquidity,
  borrowVault,
  collateralVault,
  collateralAssets,
  collateralShares,
  assetsDelta,
  isCollateralEnabled,
  enableCollateral = false,
  redeemAll = false,
}: {
  liquidity: Liquidity | undefined
  borrowVault: EVault | undefined
  collateralVault: EVault | SecuritizeCollateralVault
  collateralAssets: bigint | undefined
  collateralShares: bigint | undefined
  assetsDelta: bigint
  isCollateralEnabled: boolean | undefined
  enableCollateral?: boolean
  redeemAll?: boolean
}): CollateralLiquidityEstimate | null => {
  if (!liquidity) return null
  if (assetsDelta !== 0n && isCollateralEnabled === undefined) return null
  let oracleMid = liquidity.totalCollateralValue.oracleMid
  let liquidation = liquidity.totalCollateralValue.liquidation

  if (assetsDelta !== 0n && (isCollateralEnabled || enableCollateral)) {
    if (collateralAssets === undefined || collateralShares === undefined
      || collateralAssets < 0n || collateralShares < 0n || (!redeemAll && collateralAssets + assetsDelta < 0n)) return null
    const edge = getPositionCollateralEdge(borrowVault, collateralVault.address)
    if (!edge) return null
    const liquidationLtvBps = currentLiquidationLtvBps(edge)
    if (liquidationLtvBps === null) return null
    const current = liquidity.collaterals.find(c => c.address.toLowerCase() === collateralVault.address.toLowerCase())?.value
    const remainingShares = assetsDelta > 0n
      ? collateralShares + collateralVault.convertToShares(assetsDelta)
      : redeemAll
        ? 0n
        : collateralShares - collateralVault.previewWithdraw(-assetsDelta)
    if (remainingShares < 0n) return null

    let projectedMid = 0n
    if (remainingShares > 0n) {
      if (collateralShares > 0n && current && current.oracleMid > 0n) {
        projectedMid = current.oracleMid * remainingShares / collateralShares
      }
      else if (isLiveCollateralEdge(edge)) {
        // First deposits have no account value to scale. The controller quote is
        // for collateral shares; amountIn and amountOutMid retain their raw units.
        const quote = edge.oraclePriceRaw
        if (!quote || quote.queryFailure || quote.amountIn <= 0n || quote.amountOutMid <= 0n) return null
        projectedMid = quote.amountOutMid * remainingShares / quote.amountIn
      }
    }
    oracleMid += projectedMid - (current?.oracleMid ?? 0n)
    liquidation += projectedMid * liquidationLtvBps / BPS - (current?.liquidation ?? 0n)
  }
  if (oracleMid < 0n || liquidation < 0n) return null

  return {
    userLTV: oracleMid > 0n
      ? liquidity.liabilityValue.oracleMid * WAD / oracleMid
      : liquidity.liabilityValue.oracleMid === 0n ? 0n : null,
    healthFactor: liquidity.liabilityValue.liquidation > 0n
      ? liquidation * WAD / liquidity.liabilityValue.liquidation
      : maxUint256,
    hasLiquidationLiquidity: liquidity.liabilityValue.liquidation === 0n || liquidation > liquidity.liabilityValue.liquidation,
  }
}
