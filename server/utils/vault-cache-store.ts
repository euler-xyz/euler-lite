import { createTtlCache } from './cache'

const VAULT_CACHE_TTL_MS = 5 * 60 * 1000

export const vaultHexCache = createTtlCache<string>({
  ttlMs: VAULT_CACHE_TTL_MS,
  maxEntries: 5000,
})

export const vaultCacheKey = (chainId: number, vaultAddress: string): string =>
  `${chainId}:${vaultAddress.toLowerCase()}`
