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
const tokenMap = shallowRef(new Map<string, TokenListEntry>())
const isLoading = ref(false)
const isLoaded = ref(false)
const guard = createRaceGuard()

const loadState = {
  chainId: 0,
  timestamp: 0,
  rawTokens: [] as TokenListEntry[],
}

const filterByChain = (chainId: number) => {
  const filtered = new Map<string, TokenListEntry>()
  for (const token of loadState.rawTokens) {
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

  tokenMap.value = filtered
}

const loadTokenList = async (forceRefresh = false) => {
  try {
    const { chainId: currentChainId } = useEulerAddresses()
    const chainId = currentChainId.value
    if (!chainId) return

    const now = Date.now()

    // DefiLlama data is per-chain, so re-fetch when chain changes
    if (!forceRefresh
      && loadState.rawTokens.length > 0
      && loadState.chainId === chainId
      && (now - loadState.timestamp) < CACHE_TTL_5MIN_MS) {
      return
    }

    // When switching chains, wipe stale cross-chain data immediately so
    // consumers calling getAllTokens()/hasToken() during the refetch
    // window see "empty" rather than the previous chain's tokens.
    if (loadState.chainId !== chainId) {
      tokenMap.value = new Map()
      loadState.rawTokens = []
      loadState.chainId = 0
    }

    const gen = guard.next()
    isLoading.value = true
    isLoaded.value = false

    const res = await axios.get('/api/token-list', { params: { chainId } })
    if (guard.isStale(gen)) return

    const tokens: TokenListEntry[] = res.data?.tokens || []
    loadState.rawTokens = tokens
    loadState.timestamp = Date.now()
    loadState.chainId = chainId

    filterByChain(chainId)
    isLoaded.value = true
  }
  catch (e) {
    logWarn('tokenList/load', e)
  }
  finally {
    isLoading.value = false
  }
}

export const getTokenListLogoUrl = (address: string): string | undefined => {
  try {
    const logoURI = tokenMap.value.get(getAddress(address).toLowerCase())?.logoURI
    if (!logoURI) return undefined
    // CoinGecko /thumb/ images are 25x25 — upgrade to /small/ (64x64) for sharper display
    return logoURI.replace('/thumb/', '/small/')
  }
  catch {
    return undefined
  }
}

const hasToken = (address: string): boolean => {
  try {
    return tokenMap.value.has(getAddress(address).toLowerCase())
  }
  catch {
    return false
  }
}

const getTokenByAddress = (address: string): TokenListEntry | undefined => {
  if (!address) return undefined
  try {
    return tokenMap.value.get(getAddress(address).toLowerCase())
  }
  catch {
    return undefined
  }
}

const getTokenCategoryTags = (address: string): string[] =>
  normalizeTokenCategoryTags(getTokenByAddress(address)?.tags)

const getAllTokens = (): TokenListEntry[] => {
  return [...tokenMap.value.values()]
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

export const getAssetLogoUrl = (address: string, symbol: string): string => {
  return tokenIconOverrides.get(symbol.toLowerCase())
    ?? getTokenListLogoUrl(address)
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
