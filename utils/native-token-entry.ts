import { zeroAddress } from 'viem'
import type { TokenListEntry } from '~/composables/useTokenList'

export interface NativeCurrency {
  name: string
  symbol: string
  decimals: number
}

// The native coin is listed at the zero address only while its wrapped token
// is listed, and borrows that token's logo and tags.
export const withNativeTokenEntry = (
  tokens: ReadonlyMap<string, TokenListEntry>,
  chainId: number,
  nativeCurrency: NativeCurrency | undefined,
): Map<string, TokenListEntry> => {
  const result = new Map(tokens)
  const wrappedSymbol = nativeCurrency ? `W${nativeCurrency.symbol}`.toUpperCase() : null
  const wrapped = wrappedSymbol
    ? [...tokens.values()].find(token => token.symbol.toUpperCase() === wrappedSymbol)
    : undefined

  if (!wrapped || !nativeCurrency) {
    result.delete(zeroAddress)
    return result
  }

  const listed = tokens.get(zeroAddress)
  const logoURI = listed?.logoURI ?? wrapped.logoURI
  result.set(zeroAddress, {
    ...(listed ?? {
      chainId,
      address: zeroAddress,
      name: nativeCurrency.name,
      symbol: nativeCurrency.symbol,
      decimals: nativeCurrency.decimals,
      ...(wrapped.tags?.length ? { tags: wrapped.tags } : {}),
    }),
    ...(logoURI ? { logoURI } : {}),
  })
  return result
}
