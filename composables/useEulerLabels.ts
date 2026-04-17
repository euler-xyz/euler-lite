/* eslint-disable @typescript-eslint/no-dynamic-delete */
import axios from 'axios'
import { getAddress } from 'viem'
import type { EulerLabelPoint, EulerLabelEarnVaultEntry } from '~/entities/euler/labels'
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
      featuredEarnVaults.clear()
      notExplorableEarnVaults.clear()
      earnVaults.value = []
      verifiedVaultAddresses.value = []

      const [productRes, entitiesRes, earnRes, pointsRes] = await Promise.allSettled([
        axios.get('/api/labels/products.json', { params: { chainId } }),
        axios.get('/api/labels/entities.json', { params: { chainId } }),
        axios.get('/api/labels/earn-vaults.json', { params: { chainId } }),
        axios.get('/api/labels/points.json', { params: { chainId } }),
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
