import { createError, readBody } from 'h3'
import { isAddress } from 'viem'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { createTtlCache } from '~/server/utils/cache'
import { getEnabledChainIds, getSubgraphUris } from '~/utils/chain-env'
import { logWarn } from '~/server/utils/log'

const TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_ADDRESSES_PER_REQUEST = 1000

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'vault-factories',
})

// Factory address per `${chainId}:${lowercaseVaultAddress}`.
// Factories are immutable per vault, so entries can live 24h and up to 10k
// vaults total — larger than any realistic deployment.
const cache = createTtlCache<string>({ ttlMs: CACHE_TTL_MS, maxEntries: 10_000 })

// Per-address inflight dedup keyed by `${chainId}:${address}`.
// Concurrent requests with overlapping addresses share the same subgraph
// round-trip, and keys are always small fixed-size strings.
const inflight = new Map<string, Promise<string | undefined>>()

interface SubgraphVault {
  id: string
  factory: string
}

async function fetchFromSubgraph(
  subgraphUrl: string,
  addresses: string[],
): Promise<Record<string, string>> {
  const addressList = addresses.map(addr => `"${addr}"`).join(', ')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
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

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const body = await readBody<{ chainId?: unknown, addresses?: unknown }>(event)
  const chainId = Number(body?.chainId)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid chainId' })
  }
  if (!getEnabledChainIds().includes(chainId)) {
    throw createError({ statusCode: 400, statusMessage: 'Unsupported chainId' })
  }

  if (!Array.isArray(body?.addresses) || body.addresses.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'addresses must be a non-empty array' })
  }
  if (body.addresses.length > MAX_ADDRESSES_PER_REQUEST) {
    throw createError({ statusCode: 400, statusMessage: `addresses exceeds max of ${MAX_ADDRESSES_PER_REQUEST}` })
  }
  for (const addr of body.addresses) {
    if (typeof addr !== 'string' || !isAddress(addr)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid address in list' })
    }
  }

  const addresses = (body.addresses as string[]).map(a => a.toLowerCase())
  const factories: Record<string, string> = {}
  const uncached: string[] = []

  for (const addr of addresses) {
    const cached = cache.get(`${chainId}:${addr}`)
    if (cached) {
      factories[addr] = cached
    }
    else {
      uncached.push(addr)
    }
  }

  if (uncached.length === 0) {
    return { factories }
  }

  const subgraphUrl = getSubgraphUris()[String(chainId)]
  if (!subgraphUrl) {
    logWarn('vault-factories', `No subgraph URL for chain ${chainId}; returning partial result`)
    return { factories }
  }

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
    const batchPromise = fetchFromSubgraph(subgraphUrl, toFetch).catch((err) => {
      logWarn('vault-factories', `Subgraph query failed for chain ${chainId}:`, err instanceof Error ? err.message : err)
      return {} as Record<string, string>
    })

    for (const addr of toFetch) {
      const addrPromise = batchPromise
        .then((result) => {
          const factory = result[addr]
          if (factory) cache.set(`${chainId}:${addr}`, factory)
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

  return { factories }
})
