/* eslint-disable @typescript-eslint/no-dynamic-delete */
import axios from 'axios'
import { getAddress } from 'viem'
import type { EulerLabelPoint, EulerLabelEarnVaultEntry, EulerLabelAssetEntry } from '~/entities/euler/labels'
import type { EarnVault, Vault } from '~/entities/vault'
import { safeAssign } from '~/utils/safe-assign'
import { logger } from '~/utils/logger'
import { logWarn } from '~/utils/errorHandling'
import { CACHE_TTL_5MIN_MS } from '~/entities/tuning-constants'
import { normalizeAddress } from '~/utils/normalizeAddress'
import { clearAssetGeoCache } from '~/composables/useGeoBlock'
import {
  isLoading,
  isReady,
  loadState,
  products,
  entities,
  points,
  earnVaults,
  earnVaultBlocks,
  earnVaultRestrictions,
  featuredEarnVaults,
  deprecatedEarnVaults,
  earnVaultDescriptions,
  earnVaultNotices,
  notExplorableEarnVaults,
  verifiedVaultAddresses,
  oracleAdapters,
  loadingAdapters,
  assetBlocks,
  assetRestrictions,
  assetPatternRules,
  wrapPairs,
  type CompiledPatternRule,
  bulkLoadedAdapterChains,
  pendingBulkAdapterLoads,
} from '~/utils/eulerLabelsState'
import {
  normalizeProducts,
  normalizeEntities,
  normalizeOracleAdapters,
  getProductByVault,
  getEntitiesByVault,
  getEntitiesByEarnVault,
  getPointsByVault,
  applyVaultOverrides,
  assetMatchesAnyRestrictRule,
} from '~/utils/eulerLabelsUtils'
import { evcBatchCall, buildBatchItem } from '~/utils/multicall'
import { encodeFunctionData, decodeFunctionResult, type Hex } from 'viem'

// Minimal ERC-4626 fragment for the asset() getter. Used by discoverWrapPairs
// to find the underlying for every restricted vault asset that happens to be
// a wrapper. Non-wrappers (and non-ERC-4626 contracts) revert here; reverts
// just yield "no entry" — no wrap-pair bypass for that asset.
const ERC4626_ASSET_ABI = [
  {
    type: 'function',
    name: 'asset',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
] as const

const loadOracleAdapter = async (chainId: number, oracleAddress: string) => {
  const checksummed = getAddress(oracleAddress)
  const key = checksummed.toLowerCase()

  if (oracleAdapters[key]) {
    return oracleAdapters[key]
  }

  if (loadingAdapters.has(key)) {
    return undefined
  }

  loadingAdapters.add(key)
  try {
    const res = await axios.get('/api/oracle-adapter', { params: { chainId, address: checksummed } })
    const meta = normalizeOracleAdapters([res.data])
    safeAssign(oracleAdapters, meta)
    return oracleAdapters[key]
  }
  catch {
    return undefined
  }
  finally {
    loadingAdapters.delete(key)
  }
}

const loadOracleAdapters = async (chainId: number, addresses?: string[]) => {
  if (!addresses?.length) {
    return
  }
  await Promise.all(addresses.map(addr => loadOracleAdapter(chainId, addr)))
}

// Bulk-load every adapter known for a chain via the all.json upstream.
// Heavy call (~1 MB JSON, hundreds of adapters) — caller decides when to invoke.
// Concurrent callers share one in-flight request; cached payloads are
// considered fresh for CACHE_TTL_5MIN_MS, after which the next call refetches
// (matches the labels load cadence so adapter checks don't drift).
const loadAllOracleAdapters = async (chainId: number): Promise<void> => {
  if (!Number.isInteger(chainId) || chainId <= 0) return

  const loadedAt = bulkLoadedAdapterChains.get(chainId)
  if (loadedAt !== undefined && (Date.now() - loadedAt) < CACHE_TTL_5MIN_MS) return

  const inflight = pendingBulkAdapterLoads.get(chainId)
  if (inflight) return inflight

  const promise = (async () => {
    try {
      const res = await axios.get('/api/oracle-adapters', { params: { chainId } })
      const meta = normalizeOracleAdapters(res.data)
      safeAssign(oracleAdapters, meta)
      bulkLoadedAdapterChains.set(chainId, Date.now())
    }
    catch (err) {
      logWarn('useEulerLabels', `Failed to bulk-load oracle adapters for chain ${chainId}: ${err instanceof Error ? err.message : String(err)}`)
    }
    finally {
      pendingBulkAdapterLoads.delete(chainId)
    }
  })()

  pendingBulkAdapterLoads.set(chainId, promise)
  return promise
}

export const useEulerLabels = () => {
  const loadLabels = async (forceRefresh = false) => {
    try {
      const { getCurrentChainConfig, loadEulerConfig } = useEulerAddresses()

      if (!getCurrentChainConfig.value) {
        loadEulerConfig()
      }
      await until(getCurrentChainConfig).toBeTruthy()

      const chainId = getCurrentChainConfig.value!.chainId
      const now = Date.now()

      if (!forceRefresh
        && loadState.chainId === chainId
        && Object.keys(products).length > 0
        && (now - loadState.timestamp) < CACHE_TTL_5MIN_MS) {
        isReady.value = true
        return
      }

      isReady.value = false
      isLoading.value = true

      Object.keys(products).forEach(key => delete products[key])
      Object.keys(entities).forEach(key => delete entities[key])
      Object.keys(points).forEach(key => delete points[key])
      Object.keys(oracleAdapters).forEach(key => delete oracleAdapters[key])
      bulkLoadedAdapterChains.clear()
      Object.keys(earnVaultBlocks).forEach(key => delete earnVaultBlocks[key])
      Object.keys(earnVaultRestrictions).forEach(key => delete earnVaultRestrictions[key])
      Object.keys(deprecatedEarnVaults).forEach(key => delete deprecatedEarnVaults[key])
      Object.keys(earnVaultDescriptions).forEach(key => delete earnVaultDescriptions[key])
      Object.keys(earnVaultNotices).forEach(key => delete earnVaultNotices[key])
      Object.keys(assetBlocks).forEach(key => delete assetBlocks[key])
      Object.keys(assetRestrictions).forEach(key => delete assetRestrictions[key])
      assetPatternRules.splice(0, assetPatternRules.length)
      // Resolution cache in useGeoBlock may hold decisions computed against
      // the now-cleared pattern rules and address maps; drop it so the next
      // lookup recomputes against the freshly-loaded labels.
      clearAssetGeoCache()
      featuredEarnVaults.clear()
      notExplorableEarnVaults.clear()
      Object.keys(wrapPairs).forEach(key => delete wrapPairs[key])
      earnVaults.value = []
      verifiedVaultAddresses.value = []

      const [productRes, entitiesRes, earnRes, pointsRes, assetsRes] = await Promise.allSettled([
        axios.get('/api/labels/products.json', { params: { chainId } }),
        axios.get('/api/labels/entities.json', { params: { chainId } }),
        axios.get('/api/labels/earn-vaults.json', { params: { chainId } }),
        axios.get('/api/labels/points.json', { params: { chainId } }),
        axios.get('/api/labels/assets.json', { params: { chainId } }),
      ])

      if (productRes.status === 'fulfilled') {
        const normalizedProducts = normalizeProducts(productRes.value.data)
        safeAssign(products, normalizedProducts.products)
        verifiedVaultAddresses.value = normalizedProducts.vaultAddresses
      }
      else {
        logger.warn({ ctx: 'labels/load', err: productRes.reason }, 'failed to load products')
      }

      if (entitiesRes.status === 'fulfilled') {
        safeAssign(entities, normalizeEntities(entitiesRes.value.data))
      }
      else {
        logger.warn({ ctx: 'labels/load', err: entitiesRes.reason }, 'failed to load entities')
      }

      const earnEntries = (earnRes.status === 'fulfilled' ? earnRes.value.data ?? [] : []) as Array<string | EulerLabelEarnVaultEntry>
      earnVaults.value = earnEntries.map((entry) => {
        if (typeof entry === 'string') return normalizeAddress(entry)
        const addr = normalizeAddress(entry.address)
        if (entry.block?.length) {
          earnVaultBlocks[addr.toLowerCase()] = entry.block
        }
        if (entry.restricted?.length) {
          earnVaultRestrictions[addr.toLowerCase()] = entry.restricted
        }
        if (entry.featured) {
          featuredEarnVaults.add(addr)
        }
        if (entry.deprecated) {
          deprecatedEarnVaults[addr.toLowerCase()] = entry.deprecationReason ?? ''
        }
        if (entry.description) {
          earnVaultDescriptions[addr.toLowerCase()] = entry.description
        }
        if (entry.portfolioNotice) {
          earnVaultNotices[addr.toLowerCase()] = entry.portfolioNotice
        }
        if (entry.notExplorable) {
          notExplorableEarnVaults.add(addr.toLowerCase())
        }
        return addr
      })

      if (earnRes.status === 'rejected') {
        logger.warn({ ctx: 'labels/load', err: earnRes.reason }, 'failed to load earn-vaults')
      }

      const pointsData = (pointsRes.status === 'fulfilled' ? pointsRes.value.data ?? [] : []) as EulerLabelPoint[]
      if (pointsRes.status === 'rejected') {
        logger.warn({ ctx: 'labels/load', err: pointsRes.reason }, 'failed to load points')
      }
      pointsData.forEach((point) => {
        if (!point.collateralVaults) {
          return
        }

        point.collateralVaults.forEach((vaultAddress) => {
          const normalized = normalizeAddress(vaultAddress)
          if (!points[normalized]) {
            points[normalized] = []
          }
          points[normalized].push({
            name: point.name,
            logo: point.logo,
          })
        })
      })

      const assetEntries = (assetsRes.status === 'fulfilled' ? assetsRes.value.data ?? [] : []) as Array<EulerLabelAssetEntry>
      if (assetsRes.status === 'rejected') {
        logger.warn({ ctx: 'labels/load', err: assetsRes.reason }, 'failed to load assets')
      }
      assetEntries.forEach((entry, index) => {
        if (!entry) return

        const hasAddress = typeof entry.address === 'string'
        const hasSymbols = Array.isArray(entry.symbols) && entry.symbols.length > 0
        const hasSymbolRegex = typeof entry.symbolRegex === 'string' && entry.symbolRegex.length > 0
        const hasNames = Array.isArray(entry.names) && entry.names.length > 0
        const hasNameRegex = typeof entry.nameRegex === 'string' && entry.nameRegex.length > 0
        const hasPattern = hasSymbols || hasSymbolRegex || hasNames || hasNameRegex

        // Mixing address and pattern fields in one entry is confusing: the
        // shared `block` / `restricted` arrays apply to both sides, so there's
        // no way to scope different country lists to each match surface.
        // Split into two entries instead.
        if (hasAddress && hasPattern) {
          logWarn('labels/load', `assets.json entry #${index} mixes 'address' with pattern fields; both will apply the same block/restricted rules — split into separate entries for clarity`)
        }

        // Address-based rule: populate the fast O(1) lookup map.
        if (hasAddress) {
          const key = normalizeAddress(entry.address!).toLowerCase()
          if (entry.block?.length) {
            assetBlocks[key] = entry.block
          }
          if (entry.restricted?.length) {
            assetRestrictions[key] = entry.restricted
          }
        }

        if (!hasPattern) {
          // No pattern fields; either an address-only rule (already handled)
          // or an entry with no match fields at all (skip).
          if (!hasAddress) {
            logWarn('labels/load', `assets.json entry #${index} has no match fields; skipping`)
          }
          return
        }

        const rule: CompiledPatternRule = {
          block: entry.block?.length ? entry.block : undefined,
          restricted: entry.restricted?.length ? entry.restricted : undefined,
        }
        if (!rule.block && !rule.restricted) {
          // Pattern rule with no block/restricted is a no-op; drop it.
          return
        }

        if (hasSymbols) {
          rule.symbolsLower = new Set(entry.symbols!.map(s => s.toLowerCase()))
        }
        if (hasSymbolRegex) {
          try {
            rule.symbolRegex = new RegExp(entry.symbolRegex!, 'i')
          }
          catch (e) {
            logWarn('labels/load', `assets.json entry #${index} has invalid symbolRegex; skipping regex`, { data: e })
          }
        }
        if (hasNames) {
          rule.namesLower = new Set(entry.names!.map(s => s.toLowerCase()))
        }
        if (hasNameRegex) {
          try {
            rule.nameRegex = new RegExp(entry.nameRegex!, 'i')
          }
          catch (e) {
            logWarn('labels/load', `assets.json entry #${index} has invalid nameRegex; skipping regex`, { data: e })
          }
        }

        // If every pattern field failed to populate (e.g. all regexes invalid),
        // drop the entry entirely — no match surface.
        if (!rule.symbolsLower && !rule.symbolRegex && !rule.namesLower && !rule.nameRegex) {
          return
        }

        assetPatternRules.push(rule)
      })

      loadState.chainId = chainId
      loadState.timestamp = Date.now()
    }
    catch (e) {
      logWarn('labels/load', e)
    }
    finally {
      isLoading.value = false
      isReady.value = true
    }
  }

  /**
   * After labels and vaults are loaded, probe every vault asset that could be
   * soft-restricted in some region for an ERC-4626 `asset()` underlying.
   * Successful results are stored in `wrapPairs` (lowercased addresses) and
   * later consulted by `isWrapPair` to bypass the soft-restrict gate when an
   * operation is a technical wrap (e.g. SPYx -> wSPYx) rather than a net-new
   * acquisition of restricted exposure.
   *
   * Scoped to soft-restrict-eligible assets so we only spend RPC on the set
   * where the bypass could actually fire. Reverts and zero-address results
   * are silently dropped — non-wrappers simply don't get a pair entry, and
   * the bypass becomes a no-op for them.
   *
   * Lifetime: the map is cleared in `loadLabels` and repopulated each time
   * this function runs, so it tracks the labels reload cycle (~5 min TTL).
   */
  const discoverWrapPairs = async () => {
    try {
      const { getCurrentChainConfig } = useEulerAddresses()
      const config = getCurrentChainConfig.value
      if (!config) return

      const evcAddress = config.addresses.coreAddrs.evc
      const chainId = config.chainId
      const rpcUrl = import.meta.server
        ? `${useRequestURL().origin}/api/rpc/${chainId}`
        : `/api/rpc/${chainId}`

      const { getEvkVaults, getEarnVaults, getSecuritizeVaults } = useVaultRegistry()
      const allVaults = [...getEvkVaults(), ...getEarnVaults(), ...getSecuritizeVaults()]

      // Dedupe by checksummed asset address. We probe the asset contract
      // itself, not the vault — many vaults can share one asset.
      const seen = new Set<string>()
      type Candidate = { address: string, symbol: string, name: string }
      const candidates: Candidate[] = []
      for (const vault of allVaults) {
        const asset = vault.asset
        if (!asset?.address) continue
        const checksummed = normalizeAddress(asset.address)
        if (seen.has(checksummed)) continue
        seen.add(checksummed)
        if (!assetMatchesAnyRestrictRule(asset)) continue
        candidates.push({ address: checksummed, symbol: asset.symbol, name: asset.name })
      }

      if (candidates.length === 0) return

      const callData = encodeFunctionData({ abi: ERC4626_ASSET_ABI, functionName: 'asset' })
      const items = candidates.map(c => buildBatchItem(c.address, callData))

      let results
      try {
        results = await evcBatchCall(evcAddress, items, rpcUrl)
      }
      catch (err) {
        logWarn('labels/wrap-pairs', err)
        return
      }

      for (let i = 0; i < results.length; i++) {
        const res = results[i]
        if (!res.success || !res.result || res.result === '0x') continue
        let decoded: string
        try {
          decoded = decodeFunctionResult({
            abi: ERC4626_ASSET_ABI,
            functionName: 'asset',
            data: res.result as Hex,
          }) as string
        }
        catch {
          continue
        }
        const underlying = decoded.toLowerCase()
        if (!underlying || underlying === '0x' || underlying === '0x0000000000000000000000000000000000000000') continue
        wrapPairs[candidates[i].address.toLowerCase()] = underlying
      }
    }
    catch (e) {
      logWarn('labels/wrap-pairs', e)
    }
  }

  return {
    isLoading,
    isReady,
    verifiedVaultAddresses,
    products,
    entities,
    points,
    oracleAdapters,
    earnVaults,
    loadLabels,
    discoverWrapPairs,
    loadOracleAdapter,
    loadOracleAdapters,
    loadAllOracleAdapters,
  }
}

export const useEulerProductOfVault = (vaultAddress: string | Ref<string>) => {
  return toReactive(computed(() => {
    const addr = unref(vaultAddress)
    return applyVaultOverrides(getProductByVault(addr), addr)
  }))
}

export const useEulerEntitiesOfVault = (vault: Vault | Ref<Vault>) => {
  return toReactive(computed(() => getEntitiesByVault(unref(vault))))
}

export const useEulerEntitiesOfEarnVault = (earnVault: EarnVault | Ref<EarnVault>) => {
  return toReactive(computed(() => getEntitiesByEarnVault(unref(earnVault))))
}

export const useEulerPointsOfVault = (vaultAddress: string | Ref<string>) => {
  return toReactive(computed(() => getPointsByVault(unref(vaultAddress))))
}
