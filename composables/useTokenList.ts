import axios from 'axios'
import { getAddress, zeroAddress } from 'viem'
import type { VaultAsset } from '~/types/asset'

import { logWarn } from '~/utils/errorHandling'
import { CACHE_TTL_5MIN_MS } from '~/entities/tuning-constants'
import { getChainById } from '~/entities/chainRegistry'
import { createRaceGuard } from '~/utils/race-guard'
import { normalizeTokenCategoryTags } from '~/utils/token-categories'

export interface TokenListEntry {
  chainId: number
  address: string
  name: string
  symbol: string
  decimals: number
  logoURI?: string
  tags?: string[]
}

// Singleton state
const tokenMapsByChainId = shallowRef(new Map<number, Map<string, TokenListEntry>>())
const isLoading = ref(false)
const isLoaded = ref(false)
const guard = createRaceGuard()

const loadState = {
  timestamps: new Map<number, number>(),
}

const buildTokenMapForChain = (chainId: number, tokens: TokenListEntry[]) => {
  const filtered = new Map<string, TokenListEntry>()
  for (const token of tokens) {
    if (token.chainId !== chainId) continue
    try {
      const normalized = getAddress(token.address).toLowerCase()
      if (!filtered.has(normalized)) {
        const tags = normalizeTokenCategoryTags(token.tags)
        filtered.set(normalized, {
          chainId: token.chainId,
          address: token.address,
          name: token.name,
          symbol: token.symbol,
          decimals: token.decimals,
          ...(token.logoURI ? { logoURI: token.logoURI } : {}),
          ...(tags.length ? { tags } : {}),
        })
      }
    }
    catch {
      // skip invalid addresses
    }
  }
  // Include native currency at address zero only when the wrapped native token is in the list
  const chain = getChainById(chainId)
  const nativeSymbol = chain?.nativeCurrency?.symbol
  const wrappedSymbol = nativeSymbol ? `W${nativeSymbol}`.toUpperCase() : null
  const hasWrappedNative = wrappedSymbol
    && [...filtered.values()].find(t => t.symbol.toUpperCase() === wrappedSymbol)

  if (hasWrappedNative) {
    if (!filtered.has(zeroAddress)) {
      filtered.set(zeroAddress, {
        chainId,
        address: zeroAddress,
        name: chain!.nativeCurrency.name,
        symbol: chain!.nativeCurrency.symbol,
        decimals: chain!.nativeCurrency.decimals,
        ...(hasWrappedNative.tags?.length ? { tags: hasWrappedNative.tags } : {}),
      })
    }
  }
  else {
    filtered.delete(zeroAddress)
  }

  return filtered
}

const getDefaultChainId = (): number => {
  const { chainId } = useEulerAddresses()
  return chainId.value
}

const getTokenMapForChain = (chainId = getDefaultChainId()): Map<string, TokenListEntry> => {
  return tokenMapsByChainId.value.get(chainId) ?? new Map()
}

const getUniqueTokenByAddress = (address: string): TokenListEntry | undefined => {
  const normalized = getAddress(address).toLowerCase()
  const matches = [...tokenMapsByChainId.value.values()]
    .map(map => map.get(normalized))
    .filter((token): token is TokenListEntry => Boolean(token))
  return matches.length === 1 ? matches[0] : undefined
}

const loadTokenList = async (forceRefresh = false) => {
  try {
    const { chainId: currentChainId, selectedChainIds } = useEulerAddresses()
    const targetChainIds = selectedChainIds.value.length ? selectedChainIds.value : [currentChainId.value].filter(Boolean)
    if (!targetChainIds.length) return

    const now = Date.now()
    const needsFetch = (chainId: number) =>
      forceRefresh
      || !tokenMapsByChainId.value.has(chainId)
      || (now - (loadState.timestamps.get(chainId) ?? 0)) >= CACHE_TTL_5MIN_MS

    if (!targetChainIds.some(needsFetch)) {
      isLoaded.value = true
      return
    }

    const gen = guard.next()
    isLoading.value = true
    isLoaded.value = false

    const results = await Promise.all(targetChainIds.map(async (chainId) => {
      if (!needsFetch(chainId)) return null
      const res = await axios.get('/api/token-list', { params: { chainId } })
      const tokens: TokenListEntry[] = res.data?.tokens || []
      return { chainId, tokens }
    }))
    if (guard.isStale(gen)) return

    const next = new Map(tokenMapsByChainId.value)
    for (const result of results) {
      if (!result) continue
      next.set(result.chainId, buildTokenMapForChain(result.chainId, result.tokens))
      loadState.timestamps.set(result.chainId, Date.now())
    }
    tokenMapsByChainId.value = next
    isLoaded.value = true
  }
  catch (e) {
    logWarn('tokenList/load', e)
  }
  finally {
    isLoading.value = false
  }
}

export const getTokenListLogoUrl = (address: string, chainId?: number): string | undefined => {
  try {
    const token = chainId
      ? getTokenMapForChain(chainId).get(getAddress(address).toLowerCase())
      : getTokenMapForChain().get(getAddress(address).toLowerCase()) ?? getUniqueTokenByAddress(address)
    const logoURI = token?.logoURI
    if (!logoURI) return undefined
    // CoinGecko /thumb/ images are 25x25 — upgrade to /small/ (64x64) for sharper display
    return logoURI.replace('/thumb/', '/small/')
  }
  catch {
    return undefined
  }
}

const hasToken = (address: string, chainId = getDefaultChainId()): boolean => {
  try {
    return getTokenMapForChain(chainId).has(getAddress(address).toLowerCase())
  }
  catch {
    return false
  }
}

const getTokenByAddress = (address: string, chainId = getDefaultChainId()): TokenListEntry | undefined => {
  if (!address) return undefined
  try {
    return getTokenMapForChain(chainId).get(getAddress(address).toLowerCase())
  }
  catch {
    return undefined
  }
}

const getTokenCategoryTags = (address: string, chainId = getDefaultChainId()): string[] =>
  normalizeTokenCategoryTags(getTokenByAddress(address, chainId)?.tags)

const getAllTokens = (chainId = getDefaultChainId()): TokenListEntry[] => {
  return [...getTokenMapForChain(chainId).values()]
}

const toVaultAsset = (entry: TokenListEntry): VaultAsset => ({
  name: entry.name,
  symbol: entry.symbol,
  address: getAddress(entry.address),
  decimals: entry.decimals,
})

const tokenIconOverrides = new Map(
  Object.entries(
    import.meta.glob('~/assets/tokens/*', { eager: true, query: '?url', import: 'default' }),
  ).map(([path, url]) => {
    const symbol = path.split('/').pop()?.split('.')[0]?.toLowerCase() ?? ''
    return [symbol, url as string]
  }),
)

export const getAssetLogoUrl = (address: string, symbol: string, chainId?: number): string => {
  return tokenIconOverrides.get(symbol.toLowerCase())
    ?? getTokenListLogoUrl(address, chainId)
    ?? ''
}

export const useTokenList = () => {
  return {
    loadTokenList,
    hasToken,
    getAllTokens,
    getTokenByAddress,
    getTokenCategoryTags,
    toVaultAsset,
    isLoading,
    isLoaded,
  }
}
