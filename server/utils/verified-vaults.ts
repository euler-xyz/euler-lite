import { decodeFunctionResult, encodeFunctionData, getAddress } from 'viem'
import { createTtlCache } from './cache'
import { fetchWithTimeout } from './fetchWithTimeout'
import { INTERNAL_FETCH_HEADERS } from './internal-headers'
import { logger } from '~/utils/logger.server'
import { chainTag } from '~/utils/chain-tag'
import { resolveRpcUrl } from './rpc'

const CACHE_TTL_MS = 300_000

const VERIFIED_ARRAY_ABI = [{
  type: 'function',
  name: 'verifiedArray',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ type: 'address[]' }],
}] as const

interface ProductsJsonEntry {
  vaults?: unknown
  deprecatedVaults?: unknown
}

interface EarnVaultEntryObject {
  address?: unknown
  deprecated?: unknown
}

interface EulerChainConfig {
  chainId?: unknown
  addresses?: {
    peripheryAddrs?: {
      escrowedCollateralPerspective?: unknown
    }
  }
}

const cache = createTtlCache<Set<string>>({ ttlMs: CACHE_TTL_MS, maxEntries: 64 })
const inflight = new Map<number, Promise<Set<string>>>()

function addChecksum(set: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return
  try {
    set.add(getAddress(value))
  }
  catch {
    // Ignore malformed addresses from upstream data.
  }
}

async function fetchLabels<T>(chainId: number, file: 'products.json' | 'earn-vaults.json'): Promise<T> {
  return await $fetch<T>(`/api/labels/${file}`, { query: { chainId }, headers: INTERNAL_FETCH_HEADERS })
}

async function fetchEulerChains(): Promise<EulerChainConfig[]> {
  const data = await $fetch<unknown>('/api/euler-chains', { headers: INTERNAL_FETCH_HEADERS })
  return Array.isArray(data) ? data as EulerChainConfig[] : []
}

async function fetchEscrowAddresses(chainId: number): Promise<string[]> {
  const rpcUrl = resolveRpcUrl(chainId)
  if (!rpcUrl) return []

  const chains = await fetchEulerChains()
  const config = chains.find(c => c.chainId === chainId)
  const perspective = config?.addresses?.peripheryAddrs?.escrowedCollateralPerspective
  if (typeof perspective !== 'string' || !perspective.startsWith('0x')) return []

  const callData = encodeFunctionData({ abi: VERIFIED_ARRAY_ABI, functionName: 'verifiedArray' })
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: perspective, data: callData }, 'latest'],
  })

  const response = await fetchWithTimeout(rpcUrl, 10_000, {
    method: 'POST',
    body: payload,
    headers: { 'content-type': 'application/json' },
  })

  if (!response.ok) throw new Error(`Upstream RPC returned ${response.status}`)

  const parsed = await response.json() as { result?: unknown, error?: unknown }
  if (parsed.error) throw new Error(`Upstream RPC error: ${JSON.stringify(parsed.error)}`)
  const result = parsed.result
  if (typeof result !== 'string' || !result.startsWith('0x')) return []

  const decoded = decodeFunctionResult({
    abi: VERIFIED_ARRAY_ABI,
    functionName: 'verifiedArray',
    data: result as `0x${string}`,
  })
  return [...decoded]
}

function collectProductsAddresses(products: Record<string, ProductsJsonEntry>, set: Set<string>): void {
  for (const product of Object.values(products)) {
    if (Array.isArray(product.vaults)) {
      for (const v of product.vaults) addChecksum(set, v)
    }
    // product.deprecatedVaults intentionally skipped.
  }
}

function collectEarnAddresses(entries: unknown[], set: Set<string>): void {
  for (const entry of entries) {
    if (typeof entry === 'string') {
      addChecksum(set, entry)
      continue
    }
    if (entry && typeof entry === 'object') {
      const obj = entry as EarnVaultEntryObject
      if (obj.deprecated === true) continue
      addChecksum(set, obj.address)
    }
  }
}

async function buildVerifiedSet(chainId: number): Promise<Set<string>> {
  const set = new Set<string>()

  const [products, earn, escrow] = await Promise.allSettled([
    fetchLabels<Record<string, ProductsJsonEntry>>(chainId, 'products.json'),
    fetchLabels<unknown[]>(chainId, 'earn-vaults.json'),
    fetchEscrowAddresses(chainId),
  ])

  if (products.status === 'rejected') {
    const reason = products.reason instanceof Error ? products.reason.message : String(products.reason)
    throw new Error(`products.json fetch failed: ${reason}`)
  }
  collectProductsAddresses(products.value ?? {}, set)

  if (earn.status === 'fulfilled' && Array.isArray(earn.value)) {
    collectEarnAddresses(earn.value, set)
  }
  else if (earn.status === 'rejected') {
    logger.warn(
      { ctx: 'verified-vaults', ...chainTag(chainId), err: earn.reason },
      'earn-vaults fetch failed',
    )
  }

  if (escrow.status === 'fulfilled') {
    for (const a of escrow.value) addChecksum(set, a)
  }
  else {
    logger.warn(
      { ctx: 'verified-vaults', ...chainTag(chainId), err: escrow.reason },
      'escrow fetch failed',
    )
  }

  return set
}

export async function getVerifiedAddressSet(chainId: number): Promise<Set<string>> {
  const key = String(chainId)
  const fresh = cache.get(key)
  if (fresh) return fresh

  const pending = inflight.get(chainId)
  if (pending) return pending

  const task = (async () => {
    try {
      const set = await buildVerifiedSet(chainId)
      cache.set(key, set)
      return set
    }
    catch (err) {
      logger.warn({ ctx: 'verified-vaults', ...chainTag(chainId), err }, 'rebuild failed')
      const stale = cache.getStale(key)
      if (stale) return stale
      throw err
    }
    finally {
      inflight.delete(chainId)
    }
  })()

  inflight.set(chainId, task)
  return task
}
