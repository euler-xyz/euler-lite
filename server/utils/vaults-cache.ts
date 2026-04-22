/**
 * Server-side cache for the /api/vaults snapshot endpoint.
 *
 * - The cache itself is a plain TTL store. The 5 min TTL is a safety floor:
 *   the warm-cache plugin rewrites every entry every 5 min via a direct
 *   `refreshChainVaults()` call (force-refresh), so in steady state the
 *   cache is always "fresh" from the handler's point of view. If warm-cache
 *   stalls for multiple cycles, stale entries are still servable (via
 *   .getStale up to the staleness ceiling) until the handler falls back
 *   to a synchronous cold-path refresh.
 * - refreshChainVaults() is the only write path. In-flight dedup collapses
 *   concurrent calls (warm-cache + a cold client request arriving together)
 *   onto a single upstream pass.
 */
import { createTtlCache } from './cache'
import { createInFlightDedup } from './in-flight'
import { logWarn } from './log'
import { getVaultCategories } from './vault-categories-store'
import { INTERNAL_FETCH_HEADERS } from './internal-headers'
import { loadChainSnapshot, serialiseSnapshot } from '~/entities/vault'
import type { FetchVaultContext, SerialisedSnapshot } from '~/entities/vault'

const TTL_MS = 5 * 60_000

export const vaultsCache = createTtlCache<SerialisedSnapshot>({
  ttlMs: TTL_MS,
  maxEntries: 100,
})

const inFlight = createInFlightDedup<number, SerialisedSnapshot>()

interface EulerChainEntry {
  chainId: number
  addresses: {
    lensAddrs: {
      vaultLens: string
      eulerEarnVaultLens: string
      utilsLens: string
    }
    coreAddrs: { evc: string }
    peripheryAddrs: {
      escrowedCollateralPerspective?: string
      securitizeFactory?: string
    }
  }
}

interface EulerLabelProduct {
  vaults?: string[]
  deprecatedVaults?: string[]
  /** If true, every vault in the product is excluded from the snapshot — mirrors isVaultNotExplorable on the client. */
  notExplorable?: boolean
}

interface EarnVaultEntry {
  address: string
  /** If true, the entry is excluded from the snapshot — mirrors isEarnVaultNotExplorable on the client. */
  notExplorable?: boolean
}

const getChainConfig = async (chainId: number): Promise<EulerChainEntry | undefined> => {
  const chains = await $fetch<EulerChainEntry[]>('/api/euler-chains', { headers: INTERNAL_FETCH_HEADERS })
  return chains.find(c => c.chainId === chainId)
}

/**
 * Distil the label payloads needed by the loader. Mirrors the subset of
 * useEulerLabels that feeds into the vault-loading pipeline:
 *   - verifiedVaultAddresses: union of every `vaults[chainId]` array across all products
 *   - earnVaults: the earn-vaults.json list (array of addresses)
 *
 * Does NOT extract entities/points/descriptions — those are UI-only and the
 * loader doesn't care about them.
 */
const getLabels = async (chainId: number) => {
  const [products, earn] = await Promise.all([
    $fetch<Record<string, EulerLabelProduct>>('/api/labels/products.json', {
      query: { chainId },
      headers: INTERNAL_FETCH_HEADERS,
    }).catch(() => ({} as Record<string, EulerLabelProduct>)),
    $fetch<Array<string | EarnVaultEntry>>('/api/labels/earn-vaults.json', {
      query: { chainId },
      headers: INTERNAL_FETCH_HEADERS,
    }).catch(() => [] as Array<string | EarnVaultEntry>),
  ])

  // products.json shape: { [productKey]: { vaults: ["0x…"], deprecatedVaults: [...], notExplorable? } }
  // Verified set = union of vaults + deprecatedVaults across all products, EXCEPT products
  // flagged notExplorable (mirrors the client's explorableVaultAddresses filter in loadVaults).
  // Skipping them matters because the lens calls `getVaultInfoFull` against every address
  // in the list — notExplorable entries include decommissioned vaults whose lens calls revert.
  const verifiedSet = new Set<string>()
  for (const product of Object.values(products)) {
    if (product.notExplorable === true) continue
    product.vaults?.forEach(addr => verifiedSet.add(addr))
    product.deprecatedVaults?.forEach(addr => verifiedSet.add(addr))
  }

  // earn-vaults.json: array of { address, ... } entries, or (legacy) bare strings.
  // Skip entries marked notExplorable (deprecated earn vaults whose lens calls would revert).
  const earnVaults: string[] = earn.flatMap((entry) => {
    if (typeof entry === 'string') return [entry]
    if (entry.notExplorable === true) return []
    return [entry.address]
  })

  return {
    verifiedVaultAddresses: [...verifiedSet],
    earnVaults,
  }
}

/**
 * Split verified addresses into EVK vs Securitize using the chain-wide
 * vault categorization. Labels tell us WHICH vaults to include in the
 * snapshot; categorization tells us WHICH LENS to use for each. Addresses
 * missing from the categorization (e.g. brand-new deployments the subgraph
 * hasn't picked up yet) default to EVK since the VaultLens handles any
 * ERC-4626 + EVK-compatible deployment.
 */
const splitVerifiedByCategory = (
  verifiedAddresses: string[],
  securitizeSet: Set<string>,
): { evkVaultAddresses: string[], securitizeVaultAddresses: string[] } => {
  const evkVaultAddresses: string[] = []
  const securitizeVaultAddresses: string[] = []
  for (const addr of verifiedAddresses) {
    if (securitizeSet.has(addr.toLowerCase())) securitizeVaultAddresses.push(addr)
    else evkVaultAddresses.push(addr)
  }
  return { evkVaultAddresses, securitizeVaultAddresses }
}

/**
 * The single refresh path. Called by the warm-cache plugin on a 5-min
 * schedule, and also by the /api/vaults handler as a cold-path fallback.
 */
export const refreshChainVaults = (chainId: number): Promise<SerialisedSnapshot> =>
  inFlight.run(chainId, async () => {
    try {
      const rpcUrl = process.env[`RPC_URL_HTTP_${chainId}`]
      if (!rpcUrl) throw new Error(`No RPC URL configured for chain ${chainId}`)

      const cfg = await getChainConfig(chainId)
      if (!cfg) throw new Error(`No euler-chains entry for chain ${chainId}`)

      // Labels (what to include) + categories (how to categorize) run in parallel.
      const [labels, categories] = await Promise.all([
        getLabels(chainId),
        getVaultCategories(chainId),
      ])

      const securitizeSet = new Set(categories.securitize.map(a => a.toLowerCase()))
      const { evkVaultAddresses, securitizeVaultAddresses }
        = splitVerifiedByCategory(labels.verifiedVaultAddresses, securitizeSet)

      const ctx: FetchVaultContext = {
        chainId,
        rpcUrl,
        lensAddresses: {
          vaultLens: cfg.addresses.lensAddrs.vaultLens,
          eulerEarnVaultLens: cfg.addresses.lensAddrs.eulerEarnVaultLens,
          utilsLens: cfg.addresses.lensAddrs.utilsLens,
        },
        coreAddresses: { evc: cfg.addresses.coreAddrs.evc },
        peripheryAddresses: {
          escrowedCollateralPerspective: cfg.addresses.peripheryAddrs.escrowedCollateralPerspective,
        },
        // Server skips Pyth simulation in v1: the client's post-hydration
        // RPC refresh handles Pyth-fresh prices. See plan "Pyth on server: skip in v1".
        pythHermesUrl: undefined,
        verifiedVaultAddresses: labels.verifiedVaultAddresses,
        earnVaultAddresses: labels.earnVaults,
      }

      const snap = await loadChainSnapshot({
        chainId,
        ctx,
        evkVaultAddresses,
        securitizeVaultAddresses,
        escrowAddresses: categories.escrow,
        // Server doesn't honour nonExplorable filters — UI-only concerns.
        // The snapshot contains all verified vaults; the client applies UI
        // filters at render time.
      })

      const serialised = serialiseSnapshot(snap)
      vaultsCache.set(String(chainId), serialised)
      return serialised
    }
    catch (err) {
      logWarn('vaults-cache', `refreshChainVaults chain=${chainId} failed:`, err instanceof Error ? err.message : err)
      throw err
    }
  })
