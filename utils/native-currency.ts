import { getAddress, zeroAddress, type Address } from 'viem'
import { getChainById } from '~/entities/chainRegistry'
import type { VaultAsset } from '~/types/asset'
import { useTokenList } from '~/composables/useTokenList'

export const isNativeCurrencyAddress = (address: string): boolean => {
  try {
    return getAddress(address) === zeroAddress
  }
  catch {
    return false
  }
}

export const resolveWrappedNativeAddress = (chainId: number): Address | null => {
  const chain = getChainById(chainId)
  const nativeSymbol = chain?.nativeCurrency?.symbol
  if (!nativeSymbol) return null

  const wrappedSymbol = `W${nativeSymbol}`.toUpperCase()
  const { getAllTokens } = useTokenList()
  const match = getAllTokens().find(t => t.symbol.toUpperCase() === wrappedSymbol)

  return match ? getAddress(match.address) : null
}

/** Check if the native currency's wrapped version matches the given address (e.g. ETH selected + WETH vault). */
export const isNativeOfWrapped = (selectedAddress: string, targetAddress: string, chainId: number): boolean => {
  if (!isNativeCurrencyAddress(selectedAddress)) return false
  const wrappedAddress = resolveWrappedNativeAddress(chainId)
  if (!wrappedAddress) return false
  try {
    return getAddress(targetAddress) === wrappedAddress
  }
  catch {
    return false
  }
}

/** Resolve the wrapped native token as a VaultAsset (e.g. WETH). */
export const resolveWrappedNativeAsset = (chainId: number): VaultAsset | null => {
  const chain = getChainById(chainId)
  const nativeSymbol = chain?.nativeCurrency?.symbol
  if (!nativeSymbol) return null

  const wrappedSymbol = `W${nativeSymbol}`.toUpperCase()
  const { getAllTokens, toVaultAsset } = useTokenList()
  const match = getAllTokens().find(t => t.symbol.toUpperCase() === wrappedSymbol)

  return match ? toVaultAsset(match) : null
}
