import { getAddress, parseUnits, type Address } from 'viem'
import type { Vault, VaultIteratorResult } from './types'
import { resolveAssetPriceInfo, resolveFullAssetPriceInfo, resolveUnitOfAccountPriceInfo } from './pricing'
import { processRawVaultData, fetchVault } from './fetcher'
import { logWarn } from '~/utils/errorHandling'
import { USD_ADDRESS } from '~/entities/constants'
import { BATCH_SIZE_VAULT_FETCH } from '~/entities/tuning-constants'
import {
  eulerPerspectiveABI,
  eulerVaultLensABI,
} from '~/entities/euler/abis'
import { batchLensCalls } from '~/utils/multicall'

export const fetchEscrowVault = async (vaultAddress: string): Promise<Vault> => {
  const { rpcUrl } = useRpcClient()
  const { eulerLensAddresses } = useEulerAddresses()

  const vault = await fetchVault(vaultAddress)

  try {
    const priceInfo = await resolveFullAssetPriceInfo(
      rpcUrl.value,
      eulerLensAddresses.value!.utilsLens,
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
    logWarn('escrow/fetchAssetPrice', e)
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
export const fetchEscrowAddresses = async (): Promise<string[]> => {
  const { client: rpcClient } = useRpcClient()
  const { eulerPeripheryAddresses } = useEulerAddresses()

  await until(
    computed(() => eulerPeripheryAddresses.value?.escrowedCollateralPerspective),
  ).toBeTruthy()

  if (!eulerPeripheryAddresses.value?.escrowedCollateralPerspective) {
    return []
  }

  const client = rpcClient.value!

  try {
    const addresses = await client.readContract({
      address: eulerPeripheryAddresses.value.escrowedCollateralPerspective as Address,
      abi: eulerPerspectiveABI,
      functionName: 'verifiedArray',
    }) as string[]
    return addresses.map(addr => getAddress(addr))
  }
  catch (e) {
    logWarn('escrow/fetchAddresses', e, { severity: 'error' })
    return []
  }
}

export const fetchEscrowVaults = async function* (): AsyncGenerator<
  VaultIteratorResult<Vault>,
  void,
  unknown
> {
  const { client: rpcClient, rpcUrl } = useRpcClient()
  const { eulerPeripheryAddresses, eulerLensAddresses, eulerCoreAddresses, chainId } = useEulerAddresses()

  const startChainId = chainId.value

  await until(
    computed(() => {
      return (
        eulerPeripheryAddresses.value?.escrowedCollateralPerspective
        && eulerLensAddresses.value?.vaultLens
        && eulerLensAddresses.value?.utilsLens
      )
    }),
  ).toBeTruthy()

  if (
    !eulerPeripheryAddresses.value?.escrowedCollateralPerspective
    || !eulerLensAddresses.value?.vaultLens
    || !eulerLensAddresses.value?.utilsLens
  ) {
    throw new Error('Escrow perspective or vault lens address not loaded yet')
  }

  const client = rpcClient.value!

  let verifiedVaults: string[]
  try {
    verifiedVaults = await client.readContract({
      address: eulerPeripheryAddresses.value.escrowedCollateralPerspective as Address,
      abi: eulerPerspectiveABI,
      functionName: 'verifiedArray',
    }) as string[]
  }
  catch (e) {
    logWarn('escrow/fetchVaults', e, { severity: 'error' })
    verifiedVaults = []
  }

  const batchSize = BATCH_SIZE_VAULT_FETCH

  const fetchBatch = async (batchAddresses: string[]): Promise<Vault[]> => {
    if (eulerCoreAddresses.value?.evc) {
      const calls = batchAddresses.map(vaultAddress => ({
        functionName: 'getVaultInfoFull',
        args: [vaultAddress],
      }))

      const results = await batchLensCalls<Record<string, unknown>>(
        eulerCoreAddresses.value.evc,
        eulerLensAddresses.value!.vaultLens,
        eulerVaultLensABI,
        calls,
        rpcUrl.value,
      )

      const vaults: Vault[] = []
      const failedAddresses: string[] = []

      for (let i = 0; i < results.length; i++) {
        const result = results[i]
        if (result.success && result.result) {
          try {
            vaults.push(processRawVaultData(result.result as Record<string, unknown>, batchAddresses[i], undefined, { verified: true, vaultCategory: 'escrow' }))
          }
          catch (e) {
            logWarn('escrow/processResult', e, { severity: 'error' })
            failedAddresses.push(batchAddresses[i])
          }
        }
        else {
          failedAddresses.push(batchAddresses[i])
        }
      }

      if (failedAddresses.length > 0) {
        logWarn('escrow/fetchBatch', `Retrying ${failedAddresses.length} failed escrow vaults individually`)
        const retries = await Promise.all(
          failedAddresses.map(async (addr) => {
            try {
              const raw = await client.readContract({
                address: eulerLensAddresses.value!.vaultLens as Address,
                abi: eulerVaultLensABI,
                functionName: 'getVaultInfoFull',
                args: [addr],
              }) as Record<string, unknown>
              return processRawVaultData(raw, addr, undefined, { verified: true, vaultCategory: 'escrow' })
            }
            catch (e) {
              logWarn('escrow/fetchIndividual', e, { severity: 'error' })
              return undefined
            }
          }),
        )
        vaults.push(...retries.filter((v): v is Vault => !!v))
      }

      return vaults
    }

    // Fallback: individual readContract calls
    const res = await Promise.all(
      batchAddresses.map(async (vaultAddress) => {
        try {
          const raw = await client.readContract({
            address: eulerLensAddresses.value!.vaultLens as Address,
            abi: eulerVaultLensABI,
            functionName: 'getVaultInfoFull',
            args: [vaultAddress],
          }) as Record<string, unknown>
          return processRawVaultData(raw, vaultAddress, undefined, { verified: true, vaultCategory: 'escrow' })
        }
        catch (e) {
          logWarn('escrow/fetchVault', e, { severity: 'error' })
          return undefined
        }
      }),
    )
    return res.filter((v): v is Vault => !!v)
  }

  for (let i = 0; i < verifiedVaults.length; i += batchSize) {
    if (chainId.value !== startChainId) return

    const batch = verifiedVaults.slice(i, i + batchSize)
    let validVaults = await fetchBatch(batch)

    if (chainId.value !== startChainId) return

    const utilsLensAddress = eulerLensAddresses.value!.utilsLens
    validVaults = await Promise.all(
      validVaults.map(async (vault) => {
        const [assetPriceInfo, unitOfAccountPriceInfo] = await Promise.all([
          resolveAssetPriceInfo(rpcUrl.value, utilsLensAddress, vault.asset.address),
          resolveUnitOfAccountPriceInfo(rpcUrl.value, utilsLensAddress, vault.unitOfAccount),
        ])
        return { ...vault, assetPriceInfo, unitOfAccountPriceInfo }
      }),
    )

    validVaults = await Promise.all(
      validVaults.map(async (vault) => {
        if (
          !vault.liabilityPriceInfo
          || vault.liabilityPriceInfo.queryFailure
        ) {
          try {
            const priceInfo = await resolveFullAssetPriceInfo(
              rpcUrl.value,
              utilsLensAddress,
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
              }
            }
          }
          catch (e) {
            logWarn('escrow/fetchAssetPrice', e)
          }
        }
        return vault
      }),
    )

    const isFinished = i + batchSize >= verifiedVaults.length

    yield {
      vaults: validVaults,
      isFinished,
    }
  }
}
