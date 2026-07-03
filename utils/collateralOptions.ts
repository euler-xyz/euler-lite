import type { EVault, IHasVaultAddress, RewardCampaign, YieldApyBreakdown } from '@eulerxyz/euler-v2-sdk'
import { computeSupplyApyBreakdown } from '@eulerxyz/euler-v2-sdk'
import { getAssetUsdValueOrZero } from '~/utils/sdk-prices'
import type { CollateralOption } from '~/types/collateral-option'
import { getVaultProductName } from '~/utils/eulerLabelsUtils'
import { getVaultTags, type VaultTagContext } from '~/composables/useGeoBlock'
import { getVaultBorrowApy } from '~/utils/vault-display'

export interface ApyVisibilitySettings {
  enableIntrinsicApy: boolean
  enableRewardsApy: boolean
}

function applyVisibility(
  breakdown: YieldApyBreakdown | undefined,
  settings: ApyVisibilitySettings,
): number {
  if (!breakdown) return 0
  const intrinsic = settings.enableIntrinsicApy ? breakdown.intrinsicApy : 0
  const rewards = settings.enableRewardsApy ? breakdown.rewards : 0
  return breakdown.lending + breakdown.borrowing + intrinsic + rewards
}

/**
 * Supply-side visible APY for a vault (LEND only). Equivalent to
 * `computeSupplyApyBreakdown` + user-setting gates on intrinsic/rewards.
 */
export function computeSupplyApy(
  vault: IHasVaultAddress,
  viewer: string | undefined,
  settings: ApyVisibilitySettings,
): number {
  return applyVisibility(computeSupplyApyBreakdown(vault, viewer), settings)
}

/**
 * Borrow-side visible APY for a vault paired with a specific collateral.
 *
 * Includes BORROW + BORROW_COLLATERAL campaigns matched to the collateral.
 * LOOPING campaigns are not included here — they require a known multiplier
 * and are computed at the position level by the SDK (via Portfolio breakdowns).
 *
 * Returns `borrowApy_with_intrinsic - rewards`, mirroring the legacy shape
 * (callers display this as "borrow cost").
 */
export function computeBorrowApy(
  vault: EVault,
  viewer: string | undefined,
  settings: ApyVisibilitySettings,
  collateralAddress?: string,
): number {
  const baseBorrowApy = getVaultBorrowApy(vault)
  const intrinsic = settings.enableIntrinsicApy
    ? (1 + baseBorrowApy / 100) * (vault.intrinsicApy?.apy ?? 0)
    : 0
  const rewards = settings.enableRewardsApy
    ? sumBorrowRewardApr(vault, viewer, collateralAddress)
    : 0
  return baseBorrowApy + intrinsic - rewards
}

/**
 * Sums `BORROW` and (collateral-matched) `BORROW_COLLATERAL` campaign APRs
 * (percentage points) for a vault. Mirrors the SDK's getVaultRewardApr but
 * applied to a vault-level "what-if" query — there's no real position so we
 * can't go through computePositionsNetApyBreakdown.
 */
export function sumBorrowRewardApr(
  vault: EVault,
  viewer: string | undefined,
  collateralAddress: string | undefined,
): number {
  const campaigns: RewardCampaign[] = vault.rewards?.getActiveCampaigns({ viewer }) ?? []
  let total = 0
  for (const c of campaigns) {
    if (typeof c.apr !== 'number') continue
    if (c.action === 'BORROW') {
      total += c.apr * 100
      continue
    }
    if (
      c.action === 'BORROW_COLLATERAL'
      && collateralAddress
      && c.collateralAddress?.toLowerCase() === collateralAddress.toLowerCase()
    ) {
      total += c.apr * 100
    }
  }
  return total
}

/**
 * Sums `LOOPING` campaign APRs (percentage points) for a borrow vault paired
 * with a specific collateral, gated by the leverage multiplier sitting inside
 * the campaign's `[minMultiplier, maxMultiplier]` window. Same predicate the
 * SDK applies inside `computePositionYieldTotals`.
 */
export function sumLoopingRewardApr(
  vault: EVault,
  viewer: string | undefined,
  collateralAddress: string,
  multiplier: number,
): number {
  const campaigns: RewardCampaign[] = vault.rewards?.getActiveCampaigns({ viewer }) ?? []
  const collat = collateralAddress.toLowerCase()
  let total = 0
  for (const c of campaigns) {
    if (c.action !== 'LOOPING') continue
    if (typeof c.apr !== 'number') continue
    if (c.collateralAddress?.toLowerCase() !== collat) continue
    if (c.minMultiplier != null && multiplier < c.minMultiplier) continue
    if (c.maxMultiplier != null && multiplier > c.maxMultiplier) continue
    total += c.apr * 100
  }
  return total
}

export async function buildCollateralOption(params: {
  vault: EVault
  type: string
  amount: number
  priceAmount: number
  apy: number
  tagContext: VaultTagContext
  showBalance?: boolean
  subAccount?: string
}): Promise<CollateralOption> {
  const { vault, type, amount, priceAmount, apy, tagContext, showBalance, subAccount } = params
  const { tags, disabled } = getVaultTags(vault.address, tagContext)

  return {
    type,
    amount,
    price: await getAssetUsdValueOrZero(priceAmount, vault, 'off-chain'),
    apy,
    showBalance,
    symbol: vault.asset.symbol,
    assetAddress: vault.asset.address,
    label: getVaultProductName(vault.address) || vault.shares.name,
    vaultAddress: vault.address,
    subAccount,
    tags,
    disabled,
  }
}
