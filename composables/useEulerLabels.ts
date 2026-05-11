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
} from '~/utils/eulerLabelsUtils'
import { evcBatchCall, buildBatchItem } from '~/utils/multicall'
import { encodeFunctionData, decodeFunctionResult, type Hex } from 'viem'
import { erc4626AssetAbi } from '~/abis/erc4626'

let wrapPairProbeGeneration = 0

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
      const probeGeneration = ++wrapPairProbeGeneration

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
      // Wrap-pair discovery: probes every vault asset for an ERC-4626
      // underlying. Deferred until the vault registry is populated (loadVaults
      // runs after loadLabels per the chain in app.vue) so the asset
      // enumeration is complete. Fire-and-forget — does not block isReady.
      // Reverts and non-ERC-4626 contracts yield no entry, in which case the
      // bypass in isAssetRestrictedByCountry is a no-op for them.
      //
      // Placed inside the try-success path so cache-hit `loadLabels()` calls
      // don't re-trigger the probe — `wrapPairs` is only cleared above when
      // the main load actually runs, so a cache hit keeps the prior map.
      void probeWrapPairs(chainId, probeGeneration)
    }
    catch (e) {
      logWarn('labels/load', e)
    }
    finally {
      isLoading.value = false
      isReady.value = true
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
    loadOracleAdapter,
    loadOracleAdapters,
    loadAllOracleAdapters,
  }
}

// Matches the chunk size used by `batchLensCalls` so per-call gas in the EVC
// batchSimulation stays well within block limits even on chains with many
// vaults.
const WRAP_PAIR_PROBE_BATCH_SIZE = 25

// Probes every unique vault asset for an ERC-4626 `asset()` underlying. We
// intentionally do not filter by "asset matches a restrict rule" — restricting
// only one side of the pair (just the underlying, or just the wrapper) is a
// legitimate label-author choice and `isWrapPair` is symmetric, so populating
// the map from any direction makes the bypass work both ways. Reverts on
// non-ERC-4626 contracts are silently dropped.
//
// `startChainId` is the chain the calling `loadLabels` was bound to. Captured
// at the call site (not re-read from current config) so a chain switch during
// the async wait/probe cannot land stale results in `wrapPairs` for the new
// chain.
const probeWrapPairs = async (startChainId: number, generation: number) => {
  const isCurrentProbe = () =>
    generation === wrapPairProbeGeneration && loadState.chainId === startChainId

  try {
    const { getCurrentChainConfig } = useEulerAddresses()
    const config = getCurrentChainConfig.value
    if (!config || config.chainId !== startChainId || generation !== wrapPairProbeGeneration) return

    const evcAddress = config.addresses.coreAddrs.evc
    const { rpcUrl } = useRpcClient()
    const startRpcUrl = rpcUrl.value

    // Wait for vaults so vault.asset metadata is populated. Loaded via
    // dynamic import to break the auto-import cycle: `useVaults` references
    // `useEulerLabels`, so referencing `useVaults` from this module via
    // unimport's hoisted import closes the cycle and produces a TDZ on
    // `_$__useVaults` under Vite's dev module loader. Same applies to
    // `useVaultRegistry`, which transitively imports `useEulerLabels` via
    // `buildFetchContext` in `useFetchContext`. Matches the pattern used in
    // `entities/vault/factory.ts` for the same reason.
    const { useVaults } = await import('~/composables/useVaults')
    const { useVaultRegistry } = await import('~/composables/useVaultRegistry')
    const { isReady: isVaultsReady } = useVaults()
    if (!isVaultsReady.value) await until(isVaultsReady).toBe(true)
    if (!isCurrentProbe()) return // chain switched or labels reloaded during wait

    const { getEvkVaults, getEarnVaults, getSecuritizeVaults } = useVaultRegistry()
    const seen = new Set<string>()
    const candidates: string[] = []
    for (const vault of [...getEvkVaults(), ...getEarnVaults(), ...getSecuritizeVaults()]) {
      const asset = vault.asset
      if (!asset?.address) continue
      const checksummed = normalizeAddress(asset.address)
      if (seen.has(checksummed)) continue
      seen.add(checksummed)
      candidates.push(checksummed)
    }
    if (candidates.length === 0) return

    const callData = encodeFunctionData({ abi: erc4626AssetAbi, functionName: 'asset' })

    for (let offset = 0; offset < candidates.length; offset += WRAP_PAIR_PROBE_BATCH_SIZE) {
      const chunk = candidates.slice(offset, offset + WRAP_PAIR_PROBE_BATCH_SIZE)
      let chunkResults
      try {
        chunkResults = await evcBatchCall(evcAddress, chunk.map(addr => buildBatchItem(addr, callData)), startRpcUrl)
      }
      catch (err) {
        // Transport-level failure on this chunk — log and stop; the next
        // labels reload (~5 min) will retry the whole probe.
        logWarn('labels/wrap-pairs', err)
        return
      }
      if (!isCurrentProbe()) return // chain switched or labels reloaded mid-chunks

      for (let i = 0; i < chunkResults.length; i++) {
        if (!isCurrentProbe()) return // prevent stale per-item writes
        const res = chunkResults[i]
        if (!res.success || !res.result || res.result === '0x') continue
        try {
          const decoded = decodeFunctionResult({ abi: erc4626AssetAbi, functionName: 'asset', data: res.result as Hex }) as string
          const underlying = decoded.toLowerCase()
          if (underlying === '0x0000000000000000000000000000000000000000') continue
          wrapPairs[chunk[i].toLowerCase()] = underlying
        }
        catch { /* non-conforming asset() — skip */ }
      }
    }
  }
  catch (e) {
    logWarn('labels/wrap-pairs', e)
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
