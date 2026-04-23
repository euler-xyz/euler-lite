/* eslint-disable @typescript-eslint/no-dynamic-delete */
import axios from 'axios'
import { getAddress } from 'viem'
import type { EulerLabelPoint, EulerLabelEarnVaultEntry, EulerLabelAssetEntry } from '~/entities/euler/labels'
import type { EarnVault, Vault } from '~/entities/vault'
import { safeAssign } from '~/utils/safe-assign'
import { logWarn } from '~/utils/errorHandling'
import { CACHE_TTL_5MIN_MS } from '~/entities/tuning-constants'
import { normalizeAddress } from '~/utils/normalizeAddress'
import {
  isLoading,
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
  type CompiledPatternRule,
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
        return
      }

      isLoading.value = true

      Object.keys(products).forEach(key => delete products[key])
      Object.keys(entities).forEach(key => delete entities[key])
      Object.keys(points).forEach(key => delete points[key])
      Object.keys(oracleAdapters).forEach(key => delete oracleAdapters[key])
      Object.keys(earnVaultBlocks).forEach(key => delete earnVaultBlocks[key])
      Object.keys(earnVaultRestrictions).forEach(key => delete earnVaultRestrictions[key])
      Object.keys(deprecatedEarnVaults).forEach(key => delete deprecatedEarnVaults[key])
      Object.keys(earnVaultDescriptions).forEach(key => delete earnVaultDescriptions[key])
      Object.keys(earnVaultNotices).forEach(key => delete earnVaultNotices[key])
      Object.keys(assetBlocks).forEach(key => delete assetBlocks[key])
      Object.keys(assetRestrictions).forEach(key => delete assetRestrictions[key])
      assetPatternRules.splice(0, assetPatternRules.length)
      featuredEarnVaults.clear()
      notExplorableEarnVaults.clear()
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
        logWarn('labels/load', 'Failed to load products:', productRes.reason)
      }

      if (entitiesRes.status === 'fulfilled') {
        safeAssign(entities, normalizeEntities(entitiesRes.value.data))
      }
      else {
        logWarn('labels/load', 'Failed to load entities:', entitiesRes.reason)
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
        logWarn('labels/load', 'Failed to load earn-vaults:', earnRes.reason)
      }

      const pointsData = (pointsRes.status === 'fulfilled' ? pointsRes.value.data ?? [] : []) as EulerLabelPoint[]
      if (pointsRes.status === 'rejected') {
        logWarn('labels/load', 'Failed to load points:', pointsRes.reason)
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
        logWarn('labels/load', 'Failed to load assets:', assetsRes.reason)
      }
      assetEntries.forEach((entry, index) => {
        if (!entry) return

        // Address-based rule: populate the fast O(1) lookup map.
        if (typeof entry.address === 'string') {
          const key = normalizeAddress(entry.address).toLowerCase()
          if (entry.block?.length) {
            assetBlocks[key] = entry.block
          }
          if (entry.restricted?.length) {
            assetRestrictions[key] = entry.restricted
          }
        }

        // Pattern rule: compile once at load time, append to the iterated list.
        const hasSymbols = Array.isArray(entry.symbols) && entry.symbols.length > 0
        const hasSymbolRegex = typeof entry.symbolRegex === 'string' && entry.symbolRegex.length > 0
        const hasNames = Array.isArray(entry.names) && entry.names.length > 0
        const hasNameRegex = typeof entry.nameRegex === 'string' && entry.nameRegex.length > 0

        if (!hasSymbols && !hasSymbolRegex && !hasNames && !hasNameRegex) {
          // No pattern fields; either an address-only rule (already handled)
          // or an entry with no match fields at all (skip).
          if (typeof entry.address !== 'string') {
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
    }
  }

  return {
    isLoading,
    verifiedVaultAddresses,
    products,
    entities,
    points,
    oracleAdapters,
    earnVaults,
    loadLabels,
    loadOracleAdapter,
    loadOracleAdapters,
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
