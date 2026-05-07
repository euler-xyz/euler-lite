import { getVaultProductName } from '~/utils/eulerLabelsUtils'
import { getVaultTags, type VaultTagContext } from '~/composables/useGeoBlock'
import type { CollateralOption, Vault } from '~/entities/vault'
import { getAssetUsdValueOrZero } from '~/services/pricing/priceProvider'

export function computeSupplyApy(
  vault: Vault,
  withIntrinsicSupplyApy: (base: number, assetAddress: string) => number,
  getSupplyRewardApy: (vaultAddress: string) => number,
): number {
  const base = nanoToValue(vault.interestRateInfo.supplyAPY || 0n, 25)
  return withIntrinsicSupplyApy(base, vault.asset.address) + getSupplyRewardApy(vault.address)
}

export function computeBorrowApy(
  vault: Vault,
  withIntrinsicBorrowApy: (base: number, assetAddress: string) => number,
  getBorrowRewardApy: (vaultAddress: string, collateralAddress?: string) => number,
  collateralAddress?: string,
): number {
  const base = nanoToValue(vault.interestRateInfo.borrowAPY || 0n, 25)
  return withIntrinsicBorrowApy(base, vault.asset.address) - getBorrowRewardApy(vault.address, collateralAddress)
}

export async function buildCollateralOption(params: {
  vault: Vault
  type: string
  amount: number
  priceAmount: number
  apy: number
  tagContext: VaultTagContext
  balanceLabel?: string
  showBalance?: boolean
}): Promise<CollateralOption> {
  const { vault, type, amount, priceAmount, apy, tagContext, balanceLabel, showBalance } = params
  const { tags, disabled } = getVaultTags(vault.address, tagContext)

  return {
    type,
    amount,
    price: await getAssetUsdValueOrZero(priceAmount, vault, 'off-chain'),
    apy,
    balanceLabel,
    showBalance,
    symbol: vault.asset.symbol,
    assetAddress: vault.asset.address,
    label: getVaultProductName(vault.address) || vault.name,
    vaultAddress: vault.address,
    tags,
    disabled,
  }
}
