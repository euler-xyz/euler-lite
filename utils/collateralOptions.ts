import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { getAssetUsdValueOrZero } from '~/utils/sdk-prices'
import type { CollateralOption } from '~/types/collateral-option'
import { getVaultProductName } from '~/utils/eulerLabelsUtils'
import { getVaultTags, type VaultTagContext } from '~/composables/useGeoBlock'

export function computeSupplyApy(
  vault: EVault,
  withIntrinsicSupplyApy: (base: number, assetAddress: string) => number,
  getSupplyRewardApy: (vaultAddress: string) => number,
): number {
  const base = getVaultSupplyApy(vault)
  return withIntrinsicSupplyApy(base, vault.asset.address) + getSupplyRewardApy(vault.address)
}

export function computeBorrowApy(
  vault: EVault,
  withIntrinsicBorrowApy: (base: number, assetAddress: string) => number,
  getBorrowRewardApy: (vaultAddress: string, collateralAddress?: string) => number,
  collateralAddress?: string,
): number {
  const base = getVaultBorrowApy(vault)
  return withIntrinsicBorrowApy(base, vault.asset.address) - getBorrowRewardApy(vault.address, collateralAddress)
}

export async function buildCollateralOption(params: {
  vault: EVault
  type: string
  amount: number
  priceAmount: number
  apy: number
  tagContext: VaultTagContext
  showBalance?: boolean
}): Promise<CollateralOption> {
  const { vault, type, amount, priceAmount, apy, tagContext, showBalance } = params
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
    tags,
    disabled,
  }
}
