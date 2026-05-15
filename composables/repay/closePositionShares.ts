import { previewWithdraw, type Vault } from '~/entities/vault'

type ClosePositionCollateralSharesParams = {
  sourceVault: Vault | undefined
  sourceAssets: bigint
  sourceShares: bigint
  assetsAmount: bigint
}

export const getClosePositionCollateralShares = async ({
  sourceVault,
  sourceAssets,
  sourceShares,
  assetsAmount,
}: ClosePositionCollateralSharesParams): Promise<bigint> => {
  if (!sourceVault || assetsAmount <= 0n) return 0n

  if (assetsAmount < sourceAssets) {
    const withdrawShares = await previewWithdraw(sourceVault.address, assetsAmount)
    return sourceShares > 0n && withdrawShares > sourceShares
      ? sourceShares
      : withdrawShares
  }

  if (sourceShares > 0n) return sourceShares
  return previewWithdraw(sourceVault.address, assetsAmount)
}
