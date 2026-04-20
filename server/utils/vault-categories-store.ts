/**
 * Chain-wide vault categorization: every vault deployed on a chain, grouped
 * by how the client / server should fetch its info.
 *
 * Single source of truth for categorization used by:
 *   - /api/vaults (server) to split verifiedVaultAddresses into EVK vs Securitize
 *   - /api/rewards/merkl (server) to filter ERC20LOGPROCESSOR by chain earn set
 *   - Client's useVaultRegistry.resolveUnknown for direct-navigation fallbacks
 *   - Client's useVaults.loadVaults for the escrow address set
 *
 * The output shape intentionally mirrors what consumers iterate over:
 *
 *   { evk: [...], earn: [...], securitize: [...], escrow: [...] }
 *
 * `evk` is a SUPERSET that includes every escrow vault — escrow vaults are
 * EVK deployments with an additional marker (they live in EscrowedCollateralPerspective).
 * The lens uses the same VaultLens for both, so iterating `evk` covers all
 * EVK-compatible vaults. The `escrow` array exists separately for consumers
 * that care about the escrow distinction (UI routing, collateral lookups).
 *
 * Replaces the old /api/vault-factories per-address subgraph lookup. By
 * caching the full categorization with a 5-min TTL (vs 24h), newly-deployed
 * vaults are picked up within one warm cycle.
 *
 * Data sources:
 *   - Subgraph: paginated `vaults` query → { id, factory } for every indexed vault
 *   - /api/euler-chains: factory addresses (EVK, EulerEarn, Securitize) +
 *     EscrowedCollateralPerspective address
 *   - RPC: EscrowedCollateralPerspective.verifiedArray() for escrow set
 */
import type { Address } from 'viem'
import { createPublicClient, getAddress, http, isAddress } from 'viem'
import { createTtlCache } from './cache'
import { fetchWithTimeout, withWallClock } from './fetchWithTimeout'
import { INTERNAL_FETCH_HEADERS } from './internal-headers'
import { logWarn } from './log'
import { getSubgraphUris } from '~/utils/chain-env'
import { eulerPerspectiveABI } from '~/entities/euler/abis'

const CACHE_TTL_MS = 5 * 60_000
/** Wall-clock budget for the full catalog build (all subgraph pages + escrow RPC). */
const CATALOG_BUILD_BUDGET_MS = 30_000
const SUBGRAPH_PAGE_SIZE = 1000
// Cap at 10k vaults per chain — well above current chain sizes with room for
// growth. Exceeding this aborts the refresh without caching so we don't
// silently serve a truncated catalog.
const MAX_SUBGRAPH_PAGES = 10

export type VaultCategory = 'evk' | 'earn' | 'securitize' | 'escrow'

/**
 * Invariant: every escrow address ALSO appears in `evk` (escrow vaults are
 * EVK deployments cross-referenced against the escrow perspective). Consumers
 * that just need "all EVK-compatible vaults" iterate `evk`; consumers that
 * need to route escrow-specific UI check `escrow`.
 */
export interface VaultCategories {
  evk: string[]
  earn: string[]
  securitize: string[]
  escrow: string[]
}

interface SubgraphVault { id: string, factory: string }

interface ChainFactoryAddresses {
  evk?: string
  earn?: string
  securitize?: string
  escrowedCollateralPerspective?: string
}

const emptyCategories = (): VaultCategories => ({ evk: [], earn: [], securitize: [], escrow: [] })

/**
 * Internal wrapper that carries both the wire-shape arrays and a set index
 * for O(1) membership probes. getVaultCategory for large chains (thousands
 * of vaults) would otherwise run four linear scans per per-address lookup.
 */
interface IndexedCategories {
  data: VaultCategories
  index: {
    evk: Set<string>
    earn: Set<string>
    securitize: Set<string>
    escrow: Set<string>
  }
}

const buildIndex = (data: VaultCategories): IndexedCategories => ({
  data,
  index: {
    evk: new Set(data.evk),
    earn: new Set(data.earn),
    securitize: new Set(data.securitize),
    escrow: new Set(data.escrow),
  },
})

const categoriesCache = createTtlCache<IndexedCategories>({ ttlMs: CACHE_TTL_MS, maxEntries: 50 })
const inFlight = new Map<number, Promise<VaultCategories>>()

// Per-address inflight dedup for the single-address fallback path.
const perAddressInFlight = new Map<string, Promise<VaultCategory | undefined>>()
const perAddressCache = createTtlCache<VaultCategory>({ ttlMs: CACHE_TTL_MS, maxEntries: 2_000 })

interface EulerChainsResponse {
  chainId: number
  addresses?: {
    coreAddrs?: { eVaultFactory?: string, eulerEarnFactory?: string }
    peripheryAddrs?: { escrowedCollateralPerspective?: string, securitizeFactory?: string }
  }
}

const getChainFactoryAddresses = async (chainId: number): Promise<ChainFactoryAddresses> => {
  try {
    const chains = await $fetch<EulerChainsResponse[]>('/api/euler-chains', { headers: INTERNAL_FETCH_HEADERS })
    const entry = chains.find(c => c.chainId === chainId)
    const core = entry?.addresses?.coreAddrs
    const periphery = entry?.addresses?.peripheryAddrs
    return {
      evk: core?.eVaultFactory?.toLowerCase(),
      earn: core?.eulerEarnFactory?.toLowerCase(),
      securitize: periphery?.securitizeFactory?.toLowerCase(),
      escrowedCollateralPerspective: periphery?.escrowedCollateralPerspective,
    }
  }
  catch (err) {
    logWarn('vault-categories', `chain config fetch failed chain=${chainId}:`, err instanceof Error ? err.message : err)
    return {}
  }
}

type FactoryCategory = 'evk' | 'earn' | 'securitize'

const categorizeByFactory = (factory: string, chainFactories: ChainFactoryAddresses): FactoryCategory => {
  const f = factory.toLowerCase()
  if (chainFactories.earn && f === chainFactories.earn) return 'earn'
  if (chainFactories.securitize && f === chainFactories.securitize) return 'securitize'
  // EVK factory or unknown factory — both use the VaultLens, so default to 'evk'.
  return 'evk'
}

const paginatedSubgraphFetch = async (subgraphUrl: string): Promise<SubgraphVault[]> => {
  const collected: SubgraphVault[] = []
  let lastId = ''

  for (let page = 0; page < MAX_SUBGRAPH_PAGES; page++) {
    // Keyset pagination by id (lexical) — more efficient than offset-based
    // pagination for subgraphs and avoids rows being skipped or doubled if
    // the underlying data shifts mid-fetch.
    const resp = await fetchWithTimeout(subgraphUrl, undefined, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query VaultCategories($first: Int!, $lastId: String!) {
          vaults(first: $first, where: { id_gt: $lastId }, orderBy: id, orderDirection: asc) {
            id
            factory
          }
        }`,
        variables: { first: SUBGRAPH_PAGE_SIZE, lastId },
      }),
    })
    if (!resp.ok) throw new Error(`Subgraph returned ${resp.status}`)
    const body = await resp.json() as { data?: { vaults?: SubgraphVault[] } }
    const batch = body?.data?.vaults ?? []
    collected.push(...batch)
    if (batch.length < SUBGRAPH_PAGE_SIZE) return collected
    lastId = batch[batch.length - 1].id
  }

  throw new Error(`vault-categories: exceeded ${MAX_SUBGRAPH_PAGES}-page cap (>${MAX_SUBGRAPH_PAGES * SUBGRAPH_PAGE_SIZE} vaults)`)
}

const fetchEscrowVerifiedArray = async (
  chainId: number,
  perspectiveAddress: string | undefined,
): Promise<Set<string>> => {
  if (!perspectiveAddress) return new Set()
  const rpcUrl = process.env[`RPC_URL_HTTP_${chainId}`]
  if (!rpcUrl) {
    logWarn('vault-categories', `no RPC URL for chain=${chainId}, skipping escrow categorization`)
    return new Set()
  }
  try {
    const client = createPublicClient({ transport: http(rpcUrl) })
    const addresses = await client.readContract({
      address: perspectiveAddress as Address,
      abi: eulerPerspectiveABI,
      functionName: 'verifiedArray',
    }) as Address[]
    return new Set(addresses.map(a => a.toLowerCase()))
  }
  catch (err) {
    logWarn('vault-categories', `escrow verifiedArray failed chain=${chainId}:`, err instanceof Error ? err.message : err)
    return new Set()
  }
}

const buildCategories = async (chainId: number): Promise<VaultCategories> => {
  const subgraphUrl = getSubgraphUris()[String(chainId)]
  if (!subgraphUrl) return emptyCategories()

  const [rawVaults, chainFactories] = await Promise.all([
    paginatedSubgraphFetch(subgraphUrl),
    getChainFactoryAddresses(chainId),
  ])

  const escrowSet = await fetchEscrowVerifiedArray(chainId, chainFactories.escrowedCollateralPerspective)

  const result = emptyCategories()
  const seen = new Set<string>()
  for (const { id, factory } of rawVaults) {
    if (!id || !factory) continue
    const addr = id.toLowerCase()
    if (seen.has(addr)) continue
    seen.add(addr)

    const category = categorizeByFactory(factory, chainFactories)
    switch (category) {
      case 'earn':
        result.earn.push(addr)
        break
      case 'securitize':
        result.securitize.push(addr)
        break
      case 'evk':
        // evk array includes escrow addresses — they're EVK deployments
        // that also appear in the escrow perspective.
        result.evk.push(addr)
        if (escrowSet.has(addr)) result.escrow.push(addr)
        break
    }
  }

  return result
}

/**
 * Refresh the full chain categorization. Deduplicated per chain — concurrent
 * callers share one upstream round-trip. On failure, does NOT write the cache
 * so readers continue to see the stale entry via SWR.
 */
export const refreshVaultCategories = async (chainId: number): Promise<VaultCategories> => {
  const existing = inFlight.get(chainId)
  if (existing) return existing

  const promise = withWallClock(() => buildCategories(chainId), CATALOG_BUILD_BUDGET_MS, `vault-categories chain=${chainId}`)
    .then((cats) => {
      categoriesCache.set(chainId.toString(), buildIndex(cats))
      return cats
    })
    .finally(() => { inFlight.delete(chainId) })

  inFlight.set(chainId, promise)
  return promise
}

export interface CategoriesRead {
  data: VaultCategories
  isStale: boolean
}

const readIndexed = (chainId: number): { entry: IndexedCategories, isStale: boolean } | undefined => {
  const key = chainId.toString()
  const fresh = categoriesCache.get(key)
  if (fresh) return { entry: fresh, isStale: false }
  const stale = categoriesCache.getStale(key)
  if (stale) return { entry: stale, isStale: true }
  return undefined
}

export const readVaultCategories = (chainId: number): CategoriesRead | undefined => {
  const got = readIndexed(chainId)
  if (!got) return undefined
  return { data: got.entry.data, isStale: got.isStale }
}

/**
 * Get the full categorization with SWR semantics: fresh → return sync,
 * stale → return stale + background revalidate, cold → await refresh.
 */
export const getVaultCategories = async (chainId: number): Promise<VaultCategories> => {
  const cached = readVaultCategories(chainId)
  if (cached && !cached.isStale) return cached.data
  if (cached && cached.isStale) {
    void refreshVaultCategories(chainId).catch((err) => {
      logWarn('vault-categories', `bg revalidate chain=${chainId}:`, err instanceof Error ? err.message : err)
    })
    return cached.data
  }
  return refreshVaultCategories(chainId)
}

const fetchSingleFromSubgraph = async (
  chainId: number,
  address: string,
  chainFactories: ChainFactoryAddresses,
): Promise<FactoryCategory | undefined> => {
  const subgraphUrl = getSubgraphUris()[String(chainId)]
  if (!subgraphUrl) return undefined
  const resp = await fetchWithTimeout(subgraphUrl, undefined, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      // Address has been validated with viem isAddress() by the caller, so
      // interpolation into the query string is safe.
      query: `query VaultCategoryEntry { vault(id: "${address}") { id factory } }`,
    }),
  })
  if (!resp.ok) return undefined
  const body = await resp.json() as { data?: { vault?: SubgraphVault | null } }
  const v = body?.data?.vault
  if (!v?.factory) return undefined
  return categorizeByFactory(v.factory, chainFactories)
}

/**
 * Look up a single vault's category. Order:
 *   1. per-address cache (fresh OR stale)
 *   2. full-categorization cache (if populated for this chain)
 *   3. single-address subgraph query (fallback for brand-new deployments
 *      that haven't been picked up by the latest full refresh)
 *
 * The fallback does NOT return 'escrow' — escrow membership requires an
 * RPC call to the escrow perspective, which is only done in the full refresh.
 * Callers that need escrow categorization should use the full categorization.
 */
export const getVaultCategory = async (
  chainId: number,
  address: string,
): Promise<VaultCategory | undefined> => {
  if (!isAddress(address)) return undefined
  const normalized = getAddress(address).toLowerCase()
  const key = `${chainId}:${normalized}`

  const cachedOne = perAddressCache.get(key) ?? perAddressCache.getStale(key)
  if (cachedOne) return cachedOne

  const indexed = readIndexed(chainId)
  if (indexed) {
    const { index } = indexed.entry
    // O(1) membership probes via the pre-built Set index. Order matters:
    // 'escrow' is a subset of 'evk', so check escrow first.
    if (index.escrow.has(normalized)) {
      perAddressCache.set(key, 'escrow')
      return 'escrow'
    }
    if (index.evk.has(normalized)) {
      perAddressCache.set(key, 'evk')
      return 'evk'
    }
    if (index.earn.has(normalized)) {
      perAddressCache.set(key, 'earn')
      return 'earn'
    }
    if (index.securitize.has(normalized)) {
      perAddressCache.set(key, 'securitize')
      return 'securitize'
    }
  }

  const existing = perAddressInFlight.get(key)
  if (existing) return existing

  const promise = (async () => {
    const chainFactories = await getChainFactoryAddresses(chainId)
    const category = await fetchSingleFromSubgraph(chainId, normalized, chainFactories)
    if (category) perAddressCache.set(key, category)
    return category
  })().finally(() => { perAddressInFlight.delete(key) })

  perAddressInFlight.set(key, promise)
  return promise
}
