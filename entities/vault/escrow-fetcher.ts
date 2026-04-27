import { getAddress, parseUnits, type Address } from 'viem'
import type { Vault } from './types'
import { resolveFullAssetPriceInfo } from './pricing'
import { fetchVault, type FetchVaultContext } from './fetcher'
import { logger } from '~/utils/logger'
import { USD_ADDRESS } from '~/entities/constants'
import { eulerPerspectiveABI } from '~/entities/euler/abis'
import { getPublicClient } from '~/utils/public-client'
import { logConciseFetchError } from './log-fetch-error'

export const fetchEscrowVault = async (
  vaultAddress: string,
  ctx: FetchVaultContext,
): Promise<Vault> => {
  const vault = await fetchVault(vaultAddress, ctx)

  try {
    const priceInfo = await resolveFullAssetPriceInfo(
      ctx.rpcUrl,
      ctx.lensAddresses.utilsLens,
      vault.asset.address,
    )

    if (priceInfo && priceInfo.amountOutMid > 0n) {
      return {
        ...vault,
        liabilityPriceInfo: {
          amountIn: priceInfo.amountIn || parseUnits('1', Number(vault.asset.decimals)),
          amountOutAsk: priceInfo.amountOutAsk || priceInfo.amountOutMid,
          amountOutBid: priceInfo.amountOutBid || priceInfo.amountOutMid,
          amountOutMid: priceInfo.amountOutMid,
          queryFailure: false,
          queryFailureReason: '',
          timestamp: priceInfo.timestamp,
          oracle: priceInfo.oracle,
          asset: vault.asset.address,
          unitOfAccount: USD_ADDRESS,
        },
        vaultCategory: 'escrow' as const,
        verified: true,
      }
    }
  }
  catch (e) {
    logger.warn({ ctx: 'escrow/fetchAssetPrice', chainId: ctx.chainId, vault: vaultAddress, err: e }, 'failed to resolve escrow asset price')
  }

  return {
    ...vault,
    vaultCategory: 'escrow',
    verified: true,
  }
}

/**
 * Fetch escrow vault addresses only (no vault info).
 * Single RPC call to get the list of addresses from escrowedCollateralPerspective.
 * Used for lazy loading optimization - vault info is fetched on-demand.
 */
export const fetchEscrowAddresses = async (
  rpcUrl: string,
  escrowedCollateralPerspectiveAddress: string,
  chainId: number,
): Promise<string[]> => {
  if (!escrowedCollateralPerspectiveAddress) {
    return []
  }

  const client = getPublicClient(rpcUrl)

  try {
    const addresses = await client.readContract({
      address: escrowedCollateralPerspectiveAddress as Address,
      abi: eulerPerspectiveABI,
      functionName: 'verifiedArray',
    }) as string[]
    return addresses.map(addr => getAddress(addr))
  }
  catch (e) {
    logConciseFetchError('escrow/fetchAddresses', chainId, 'addresses', e)
    return []
  }
}
