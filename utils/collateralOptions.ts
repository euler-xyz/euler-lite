import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { getAssetUsdValueOrZero } from '~/utils/sdk-prices'
import type { CollateralOption } from '~/types/collateral-option'
import { getVaultProductName } from '~/utils/eulerLabelsUtils'
import { getVaultTags, type VaultTagContext } from '~/composables/useGeoBlock'
import { withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'

export function computeSupplyApy(
  vault: EVault,
  getSupplyRewardApy: (vaultAddress: string) => number,
  enableIntrinsicApy: boolean,
): number {
  const base = getVaultSupplyApy(vault)
  return withVaultIntrinsicApy(base, vault, enableIntrinsicApy) + getSupplyRewardApy(vault.address)
}

export function computeBorrowApy(
  vault: EVault,
  getBorrowRewardApy: (vaultAddress: string, collateralAddress?: string) => number,
  enableIntrinsicApy: boolean,
  collateralAddress?: string,
): number {
  const base = getVaultBorrowApy(vault)
  return withVaultIntrinsicApy(base, vault, enableIntrinsicApy) - getBorrowRewardApy(vault.address, collateralAddress)
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
