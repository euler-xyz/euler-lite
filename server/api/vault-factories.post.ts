import { createError, readBody } from 'h3'
import { isAddress } from 'viem'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { createTtlCache } from '~/server/utils/cache'
import { getEnabledChainIds, getSubgraphUris } from '~/utils/chain-env'
import { logWarn } from '~/server/utils/log'

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

// Deduplicate concurrent subgraph fetches for the same (chainId, address-set).
const inflight = new Map<string, Promise<Record<string, string>>>()

interface SubgraphVault {
  id: string
  factory: string
}

async function fetchFromSubgraph(
  subgraphUrl: string,
  addresses: string[],
): Promise<Record<string, string>> {
  const addressList = addresses.map(addr => `"${addr}"`).join(', ')
  const resp = await fetch(subgraphUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

  const sortedUncached = [...uncached].sort()
  const inflightKey = `${chainId}:${sortedUncached.join(',')}`
  const existing = inflight.get(inflightKey)

  const fetchPromise = existing ?? (async () => {
    try {
      const fetched = await fetchFromSubgraph(subgraphUrl, sortedUncached)
      for (const [addr, factory] of Object.entries(fetched)) {
        cache.set(`${chainId}:${addr}`, factory)
      }
      return fetched
    }
    finally {
      inflight.delete(inflightKey)
    }
  })()

  if (!existing) {
    inflight.set(inflightKey, fetchPromise)
  }

  try {
    const fetched = await fetchPromise
    Object.assign(factories, fetched)
    return { factories }
  }
  catch (err) {
    logWarn('vault-factories', `Subgraph query failed for chain ${chainId}:`, err instanceof Error ? err.message : err)
    return { factories }
  }
})
