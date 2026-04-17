/**
 * Shared cache + fetcher for vault factory lookups.
 *
 * Extracted from server/api/vault-factories.post.ts so server-internal
 * callers (vaults-cache, warm-cache) can reuse the same 24h cache without
 * a self-HTTP round-trip. The POST endpoint is a thin wrapper around
 * getVaultFactories() below.
 */
import { createTtlCache } from './cache'
import { getSubgraphUris } from '~/utils/chain-env'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const SUBGRAPH_TIMEOUT_MS = 10_000

/** Factory address per `${chainId}:${lowercaseVaultAddress}`. */
export const vaultFactoryCache = createTtlCache<string>({
  ttlMs: CACHE_TTL_MS,
  maxEntries: 10_000,
})

/**
 * Per-address inflight dedup keyed by `${chainId}:${address}`. Concurrent
 * requests with overlapping addresses share the same subgraph round-trip,
 * and keys stay bounded to small fixed-size strings.
 */
const inflight = new Map<string, Promise<string | undefined>>()

interface SubgraphVault {
  id: string
  factory: string
}

const fetchFromSubgraph = async (
  subgraphUrl: string,
  addresses: string[],
): Promise<Record<string, string>> => {
  const addressList = addresses.map(addr => `"${addr}"`).join(', ')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SUBGRAPH_TIMEOUT_MS)
  try {
    const resp = await fetch(subgraphUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        query: `query VaultFactories {
          vaults(first: 1000, where: { id_in: [${addressList}] }) {
            id
            factory
          }
        }`,
      }),
    })

    if (!resp.ok) {
      throw new Error(`Subgraph returned ${resp.status}`)
    }

    const body = await resp.json() as { data?: { vaults?: SubgraphVault[] } }
    const vaults = body?.data?.vaults ?? []
    const result: Record<string, string> = {}
    for (const vault of vaults) {
      if (vault.id && vault.factory) {
        result[vault.id.toLowerCase()] = vault.factory.toLowerCase()
      }
    }
    return result
  }
  finally {
    clearTimeout(timeout)
  }
}

/**
 * Resolve factory addresses for a batch of (already-validated) vault addresses.
 * Caller must pre-validate with viem isAddress() when the input is untrusted —
 * this function does NOT re-validate and injects lowercase addresses into a
 * GraphQL query, so untrusted input would be an injection vector. See the
 * POST handler for the sanitisation it applies.
 *
 * Returns a map of lowercase-address → lowercase-factory. Missing vaults
 * (not indexed yet, not matching the query) are absent from the result.
 *
 * Per-address inflight dedup means concurrent callers with overlapping
 * address sets share the same upstream query; the batched fetch resolves
 * every participating address in one round-trip.
 */
export const getVaultFactories = async (
  chainId: number,
  addresses: string[],
): Promise<Record<string, string>> => {
  if (addresses.length === 0) return {}

  const normalized = addresses.map(a => a.toLowerCase())
  const factories: Record<string, string> = {}
  const uncached: string[] = []

  for (const addr of normalized) {
    const cached = vaultFactoryCache.get(`${chainId}:${addr}`)
    if (cached) factories[addr] = cached
    else uncached.push(addr)
  }

  if (uncached.length === 0) return factories

  const subgraphUrl = getSubgraphUris()[String(chainId)]
  if (!subgraphUrl) return factories

  // Split uncached addresses into those already inflight vs needing a fresh fetch.
  const promises: Array<[string, Promise<string | undefined>]> = []
  const toFetch: string[] = []

  for (const addr of uncached) {
    const key = `${chainId}:${addr}`
    const existing = inflight.get(key)
    if (existing) {
      promises.push([addr, existing])
    }
    else {
      toFetch.push(addr)
    }
  }

  if (toFetch.length > 0) {
    const batchPromise = fetchFromSubgraph(subgraphUrl, toFetch).catch(() => ({} as Record<string, string>))

    for (const addr of toFetch) {
      const addrPromise = batchPromise
        .then((result) => {
          const factory = result[addr]
          if (factory) vaultFactoryCache.set(`${chainId}:${addr}`, factory)
          return factory
        })
        .finally(() => { inflight.delete(`${chainId}:${addr}`) })
      inflight.set(`${chainId}:${addr}`, addrPromise)
      promises.push([addr, addrPromise])
    }
  }

  await Promise.all(promises.map(async ([addr, promise]) => {
    const factory = await promise
    if (factory) factories[addr] = factory
  }))

  return factories
}
